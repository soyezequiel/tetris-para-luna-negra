import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import {
  NGE,
  NgeError,
  NGE_KIND,
  parseNgeUri,
  requestTemplate,
  responseTemplate,
  notificationTemplate,
  decryptPayload,
  auditSettlement,
  type NgeBet,
  type NgeTransport,
  type NgeResponsePayload,
} from "../sdk/nge.js";

// Conformance del SDK NGE vendorizado (core + cliente) contra los vectores
// firmados de Luna (sdk/nge-test-vectors.json, sincronizado con el core). Tetris
// posee el cliente, así que su conformance vive acá; además re-verifica el core
// contra los vectores para atrapar un sync corrupto. Misma URI, mismo `content`
// cifrado (nonce fijo → determinista), mismos ids, mismo cableado req↔resp. Las
// firmas se VERIFICAN (BIP-340 lleva aux aleatorio), no se comparan.
const V = JSON.parse(
  readFileSync(new URL("../sdk/nge-test-vectors.json", import.meta.url), "utf8"),
) as any;

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const escrowSk = hexToBytes(V.keys.escrow.sk);
const clientSk = hexToBytes(V.keys.client.sk);
const escrowPk: string = V.keys.escrow.pubkey;
const clientPk: string = V.keys.client.pubkey;
const nonce = hexToBytes(V.crypto.nonce);

const canon = (method: string) => V.canonical.find((c: any) => c.method === method);

// ── parseNgeUri ──────────────────────────────────────────────────────────────
describe("parseNgeUri", () => {
  it("deriva escrow/relays/clientPubkey del string mínimo de 3 campos", () => {
    const c = parseNgeUri(V.uri);
    expect(c.escrowPubkey).toBe(V.parsed.escrowPubkey);
    expect(c.relays).toEqual(V.parsed.relays);
    expect(c.clientPubkey).toBe(V.parsed.clientPubkey);
    expect(c.clientPubkey).toBe(getPublicKey(clientSk)); // = getPublicKey(secret)
  });

  it("rechaza esquema y campos faltantes", () => {
    expect(() => parseNgeUri("https://foo?x=1")).toThrow(/nostr\+nge/);
    expect(() => parseNgeUri(`nostr+nge://${escrowPk}?secret=nsec1x`)).toThrow(/relay/);
    expect(() => parseNgeUri(`nostr+nge://${escrowPk}?relay=wss://r`)).toThrow(/secret/);
  });
});

// ── Builders puros vs vectores (content + id deterministas) ──────────────────
describe("builders puros reproducen el content/id de cada par del vector", () => {
  for (const c of V.canonical) {
    it(`request de ${c.method}`, () => {
      const tmpl = requestTemplate(c.requestPayload, {
        escrowPubkey: escrowPk,
        secretKey: clientSk,
        createdAt: c.request.created_at,
        nonce,
      });
      expect(tmpl.kind).toBe(NGE_KIND.request);
      expect(tmpl.content).toBe(c.request.content);
      const ev = finalizeEvent(tmpl, clientSk);
      expect(ev.id).toBe(c.request.id); // el id (hash) es determinista aunque la firma no
      expect(ev.pubkey).toBe(clientPk); // el request lo firma `C`
    });

    it(`response de ${c.method}`, () => {
      const tmpl = responseTemplate(c.responsePayload, {
        clientPubkey: clientPk,
        requestId: c.request.id,
        secretKey: escrowSk,
        createdAt: c.response.created_at,
        nonce,
      });
      expect(tmpl.kind).toBe(NGE_KIND.response);
      expect(tmpl.content).toBe(c.response.content);
      // la response tiene que tagear el id del request y la pubkey del cliente
      expect(tmpl.tags).toContainEqual(["e", c.request.id]);
      expect(tmpl.tags).toContainEqual(["p", clientPk]);
      const ev = finalizeEvent(tmpl, escrowSk);
      expect(ev.id).toBe(c.response.id);
      expect(ev.pubkey).toBe(escrowPk); // la response la firma `S`
    });
  }
});

// ── Cifrado NIP-44 C↔S (round-trip contra el ciphertext del vector) ──────────
describe("cifrado NIP-44 simétrico C↔S", () => {
  for (const c of V.canonical) {
    it(`${c.method}: descifra request y response a sus payloads`, () => {
      // el escrow descifra el request de `C`
      expect(decryptPayload(c.request.content, escrowSk, clientPk)).toEqual(c.requestPayload);
      // el juego descifra la response de `S`
      expect(decryptPayload(c.response.content, clientSk, escrowPk)).toEqual(c.responsePayload);
    });
  }
});

// ── Firmas ───────────────────────────────────────────────────────────────────
describe("todos los eventos del vector verifican firma", () => {
  it("canónicos (request+response) + adversariales con evento firmado", () => {
    const evs: Event[] = [
      ...V.canonical.flatMap((c: any) => [c.request, c.response]),
      ...V.adversarial.filter((a: any) => a.request).map((a: any) => a.request),
    ];
    expect(evs.length).toBeGreaterThanOrEqual(10);
    for (const ev of evs) expect(verifyEvent(ev)).toBe(true);
  });
});

// ── Fake escrow en memoria (mismo cableado que el src/lib/nge-service.ts de Luna) ─
// Descifra el request de `C`, resuelve con un handler y publica una response
// firmada por `S`, tagueada `["e", <id request>]`. Ejercita el RPC completo del
// cliente (firma → publish → suscripción a su propia response → descifrado).
type Handler = (method: string, params: Record<string, unknown>) => NgeResponsePayload;

function filterMatches(ev: Event, f: Record<string, unknown>): boolean {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  if (Array.isArray(f.authors) && !(f.authors as string[]).includes(ev.pubkey)) return false;
  for (const [k, vals] of Object.entries(f)) {
    if (!k.startsWith("#") || !Array.isArray(vals)) continue;
    const name = k.slice(1);
    if (!ev.tags.some((t) => t[0] === name && (vals as string[]).includes(t[1]))) return false;
  }
  return true;
}

function fakeEscrow(handler: Handler) {
  const subs: { filter: Record<string, unknown>; onEvent: (e: Event) => void }[] = [];
  const published: Event[] = [];
  const transport: NgeTransport = {
    async publish(ev) {
      published.push(ev);
      let req: { method: string; params?: Record<string, unknown> };
      try {
        req = decryptPayload(ev.content, escrowSk, ev.pubkey) as typeof req;
      } catch {
        return; // basura: el escrow real la ignoraría
      }
      const payload = handler(req.method, req.params ?? {});
      const resp = finalizeEvent(
        responseTemplate(payload, {
          clientPubkey: ev.pubkey,
          requestId: ev.id,
          secretKey: escrowSk,
        }),
        escrowSk,
      );
      // entrega asíncrona (como un relay real) para no cortar el rpc antes de que
      // arme sus timers de reenvío/timeout.
      queueMicrotask(() => {
        for (const s of subs) if (filterMatches(resp, s.filter)) s.onEvent(resp);
      });
    },
    subscribe(filter, onEvent) {
      const entry = { filter: filter as Record<string, unknown>, onEvent };
      subs.push(entry);
      return () => {
        const i = subs.indexOf(entry);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    close() {},
  };
  return { transport, published };
}

function connect(handler: Handler) {
  const { transport, published } = fakeEscrow(handler);
  const nge = NGE.connect(V.uri, { transport, resendMs: 50, timeoutMs: 2000 });
  return { nge, published };
}

// Handler del camino feliz: responde con el responsePayload canónico por método.
const happy: Handler = (method) => canon(method).responsePayload as NgeResponsePayload;

describe("NGE cliente — RPC contra el fake escrow", () => {
  it("getInfo devuelve la config del escrow (reemplaza al bind de v1)", async () => {
    const { nge } = connect(happy);
    const info = await nge.getInfo();
    expect(info).toEqual(canon("get_info").responsePayload.result);
    nge.close();
  });

  it("createBet firma+publica un request válido y devuelve betId + deposits", async () => {
    const { nge, published } = connect(happy);
    const params = canon("create_bet").requestPayload.params;
    const res = await nge.createBet({
      seats: [
        { seatId: "alice", pubkey: params.seats[0].pubkey, payoutAddress: params.seats[0].payoutAddress },
        { seatId: "bob" },
      ],
      stakeSats: params.stakeSats,
      condition: params.condition,
      clientRef: params.clientRef,
    });
    expect(res).toEqual(canon("create_bet").responsePayload.result);

    // el request que salió al relay descifra a un create_bet bien formado
    expect(published).toHaveLength(1);
    expect(published[0].kind).toBe(NGE_KIND.request);
    const sent = decryptPayload(published[0].content, escrowSk, published[0].pubkey) as any;
    expect(sent.method).toBe("create_bet");
    expect(sent.params.stakeSats).toBe(params.stakeSats);
    expect(sent.params.clientRef).toBe(params.clientRef);
    expect(sent.params.seats.map((s: any) => s.seatId)).toEqual(["alice", "bob"]);
    nge.close();
  });

  it("createBet rechaza sin llegar al escrow si hay <2 asientos o seatId duplicado", async () => {
    const { nge, published } = connect(happy);
    await expect(nge.createBet({ seats: [{ seatId: "solo" }], stakeSats: 1000 })).rejects.toThrow(
      /asiento/,
    );
    await expect(
      nge.createBet({ seats: [{ seatId: "a" }, { seatId: "a" }], stakeSats: 1000 }),
    ).rejects.toThrow(/duplicado/);
    expect(published).toHaveLength(0); // validación local: nada se publicó
    nge.close();
  });

  it("getBet devuelve la fuente de verdad (estado + asientos)", async () => {
    const { nge } = connect(happy);
    const bet = await nge.getBet(canon("get_bet").requestPayload.params.betId);
    expect(bet).toEqual(canon("get_bet").responsePayload.result);
    expect(bet.status).toBe("funded");
    expect(bet.potSats).toBe(2000);
    nge.close();
  });

  it("reportResult devuelve { ok, status: settled }", async () => {
    const { nge } = connect(happy);
    const r = await nge.reportResult(canon("report_result").requestPayload.params.betId, ["alice"]);
    expect(r).toEqual(canon("report_result").responsePayload.result);
    nge.close();
  });

  it("reenviar no rompe: el escrow deduplica y el cliente resuelve una sola vez", async () => {
    // resendMs corto fuerza al menos un reenvío antes de que llegue la response.
    let calls = 0;
    const { nge } = connect((method) => {
      calls++;
      return canon(method).responsePayload as NgeResponsePayload;
    });
    const info = await nge.getInfo();
    expect(info.version).toBeDefined();
    // el fake escrow puede recibir >1 publish (reenvío), pero el cliente resuelve 1 vez
    expect(calls).toBeGreaterThanOrEqual(1);
    nge.close();
  });
});

// ── Notification 24942 `bet_updated` (push §9, v1.1) ─────────────────────────
describe("notification 24942 bet_updated", () => {
  const N = V.notifications[0];

  it("notificationTemplate reproduce content/id del vector; tag p, SIN tag e", () => {
    const tmpl = notificationTemplate(N.payload, {
      clientPubkey: clientPk,
      secretKey: escrowSk,
      createdAt: N.event.created_at,
      nonce,
    });
    expect(tmpl.kind).toBe(NGE_KIND.notification);
    expect(tmpl.content).toBe(N.event.content);
    expect(tmpl.tags).toContainEqual(["p", clientPk]);
    expect(tmpl.tags.some((t: string[]) => t[0] === "e")).toBe(false);
    const ev = finalizeEvent(tmpl, escrowSk);
    expect(ev.id).toBe(N.event.id);
    expect(ev.pubkey).toBe(escrowPk); // la notification la firma `S`
  });

  it("subscribeNotifications entrega el payload del vector y descarta impostores", () => {
    const subs: { filter: Record<string, unknown>; onEvent: (e: Event) => void }[] = [];
    const transport: NgeTransport = {
      async publish() {},
      subscribe(filter, onEvent) {
        subs.push({ filter: filter as Record<string, unknown>, onEvent });
        return () => {};
      },
      close() {},
    };
    const nge = NGE.connect(V.uri, { transport });
    const got: unknown[] = [];
    nge.subscribeNotifications((n) => got.push(n));

    expect(subs).toHaveLength(1);
    expect(subs[0].filter.kinds).toEqual([NGE_KIND.notification]);
    expect(subs[0].filter.authors).toEqual([escrowPk]);

    // evento legítimo del vector → llega el payload descifrado
    subs[0].onEvent(N.event as Event);
    // impostor: mismo content pero firmado por el attacker → se descarta en silencio
    const forged = finalizeEvent(
      {
        kind: NGE_KIND.notification,
        created_at: N.event.created_at,
        tags: [["p", clientPk]],
        content: N.event.content,
      },
      hexToBytes(V.keys.attacker.sk),
    );
    subs[0].onEvent(forged);

    expect(got).toEqual([N.payload]);
    nge.close();
  });
});

// ── auditSettlement (auditoría de liquidación del lado cliente, v1.1) ────────
describe("auditSettlement", () => {
  // get_info del vector: feePct 2 + devFeePct 1, feeMinSats 10.
  const info = canon("get_info").responsePayload.result;
  const settledBet = (): NgeBet => ({
    betId: "b1",
    status: "settled",
    stakeSats: 1000,
    potSats: 2000,
    deadlineSec: null,
    seats: [
      // pozo 2000 - 3% (60 sats) = 1940 exacto: consistente con lo declarado.
      { seatId: "alice", deposited: true, payout: { tier: "zap", sats: 1940, status: "paid" } },
      { seatId: "bob", deposited: true, payout: null },
    ],
    result: { winners: ["alice"] },
  });

  it("liquidación consistente con get_info → sin anomalías", () => {
    expect(auditSettlement(settledBet(), info)).toEqual([]);
  });

  it("no audita apuestas no terminales", () => {
    const bet = settledBet();
    bet.status = "funded";
    expect(auditSettlement(bet, info)).toEqual([]);
  });

  it("pagos que superan el pozo → anomalía", () => {
    const bet = settledBet();
    bet.seats[0].payout!.sats = 2500;
    expect(auditSettlement(bet, info).join(" ")).toMatch(/pozo/);
  });

  it("ganador que cobró menos que pozo - fees declaradas → anomalía", () => {
    const bet = settledBet();
    bet.seats[0].payout!.sats = 1000;
    expect(auditSettlement(bet, info).length).toBeGreaterThan(0);
  });

  it("ganador sin payout reportado → anomalía", () => {
    const bet = settledBet();
    bet.seats[0].payout = null;
    expect(auditSettlement(bet, info).join(" ")).toMatch(/sin payout/);
  });

  it("reembolso por debajo del stake → anomalía", () => {
    const bet = settledBet();
    bet.status = "refunded";
    bet.result = null;
    bet.seats[0].payout = { tier: "lnurl", sats: 500, status: "paid" };
    bet.seats[1].payout = { tier: "lnurl", sats: 1000, status: "paid" };
    expect(auditSettlement(bet, info).join(" ")).toMatch(/stake/);
  });
});

// ── El cliente propaga los errores del escrow (adversarial del vector) ───────
describe("errores del escrow → NgeError con el mismo code", () => {
  for (const a of V.adversarial.filter((x: any) => x.method)) {
    it(`${a.name} → ${a.expect.error.code}`, async () => {
      const { nge } = connect((method) => ({ result_type: method, error: a.expect.error }));
      const drive = (): Promise<unknown> => {
        switch (a.method) {
          case "create_bet":
            return nge.createBet({
              seats: [{ seatId: "alice" }, { seatId: "bob" }],
              stakeSats: a.params.stakeSats ?? 1000,
            });
          case "report_result":
            return nge.reportResult(a.params.betId, a.params.winners);
          case "cancel_bet":
            return nge.cancelBet(a.params.betId);
          default:
            throw new Error(`método adversarial no cubierto: ${a.method}`);
        }
      };
      await expect(drive()).rejects.toBeInstanceOf(NgeError);
      await expect(drive()).rejects.toMatchObject({ code: a.expect.error.code });
      nge.close();
    });
  }
});
