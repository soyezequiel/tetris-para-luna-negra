var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/partyserver/dist/index.js
import { DurableObject, env } from "cloudflare:workers";

// node_modules/partyserver/node_modules/nanoid/url-alphabet/index.js
var urlAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

// node_modules/partyserver/node_modules/nanoid/index.browser.js
var nanoid = /* @__PURE__ */ __name((size = 21) => {
  let id = "";
  let bytes = crypto.getRandomValues(new Uint8Array(size |= 0));
  while (size--) {
    id += urlAlphabet[bytes[size] & 63];
  }
  return id;
}, "nanoid");

// node_modules/partyserver/dist/index.js
if (!("OPEN" in WebSocket)) {
  const WebSocketStatus = {
    CONNECTING: WebSocket.READY_STATE_CONNECTING,
    OPEN: WebSocket.READY_STATE_OPEN,
    CLOSING: WebSocket.READY_STATE_CLOSING,
    CLOSED: WebSocket.READY_STATE_CLOSED
  };
  Object.assign(WebSocket, WebSocketStatus);
  Object.assign(WebSocket.prototype, WebSocketStatus);
}
function tryGetPartyServerMeta(ws) {
  try {
    const attachment = WebSocket.prototype.deserializeAttachment.call(ws);
    if (!attachment || typeof attachment !== "object") return null;
    if (!("__pk" in attachment)) return null;
    const pk = attachment.__pk;
    if (!pk || typeof pk !== "object") return null;
    const { id, tags } = pk;
    if (typeof id !== "string") return null;
    const { uri } = pk;
    return {
      id,
      tags: Array.isArray(tags) ? tags : [],
      uri: typeof uri === "string" ? uri : void 0
    };
  } catch {
    return null;
  }
}
__name(tryGetPartyServerMeta, "tryGetPartyServerMeta");
function isPartyServerWebSocket(ws) {
  return tryGetPartyServerMeta(ws) !== null;
}
__name(isPartyServerWebSocket, "isPartyServerWebSocket");
var AttachmentCache = class {
  static {
    __name(this, "AttachmentCache");
  }
  #cache = /* @__PURE__ */ new WeakMap();
  get(ws) {
    let attachment = this.#cache.get(ws);
    if (!attachment) {
      attachment = WebSocket.prototype.deserializeAttachment.call(ws);
      if (attachment !== void 0) this.#cache.set(ws, attachment);
      else throw new Error("Missing websocket attachment. This is most likely an issue in PartyServer, please open an issue at https://github.com/cloudflare/partykit/issues");
    }
    return attachment;
  }
  set(ws, attachment) {
    this.#cache.set(ws, attachment);
    WebSocket.prototype.serializeAttachment.call(ws, attachment);
  }
};
var attachments = new AttachmentCache();
var connections = /* @__PURE__ */ new WeakSet();
var isWrapped = /* @__PURE__ */ __name((ws) => {
  return connections.has(ws);
}, "isWrapped");
var createLazyConnection = /* @__PURE__ */ __name((ws) => {
  if (isWrapped(ws)) return ws;
  let initialState;
  if ("state" in ws) {
    initialState = ws.state;
    delete ws.state;
  }
  const connection = Object.defineProperties(ws, {
    id: {
      configurable: true,
      get() {
        return attachments.get(ws).__pk.id;
      }
    },
    uri: {
      configurable: true,
      get() {
        return attachments.get(ws).__pk.uri ?? null;
      }
    },
    tags: {
      configurable: true,
      get() {
        return attachments.get(ws).__pk.tags ?? [];
      }
    },
    socket: {
      configurable: true,
      get() {
        return ws;
      }
    },
    state: {
      configurable: true,
      get() {
        return ws.deserializeAttachment();
      }
    },
    setState: {
      configurable: true,
      value: /* @__PURE__ */ __name(function setState(setState) {
        let state;
        if (setState instanceof Function) state = setState(this.state);
        else state = setState;
        ws.serializeAttachment(state);
        return state;
      }, "setState")
    },
    deserializeAttachment: {
      configurable: true,
      value: /* @__PURE__ */ __name(function deserializeAttachment() {
        return attachments.get(ws).__user ?? null;
      }, "deserializeAttachment")
    },
    serializeAttachment: {
      configurable: true,
      value: /* @__PURE__ */ __name(function serializeAttachment(attachment) {
        const setting = {
          ...attachments.get(ws),
          __user: attachment ?? null
        };
        attachments.set(ws, setting);
      }, "serializeAttachment")
    }
  });
  if (initialState) connection.setState(initialState);
  connections.add(connection);
  return connection;
}, "createLazyConnection");
var HibernatingConnectionIterator = class {
  static {
    __name(this, "HibernatingConnectionIterator");
  }
  index = 0;
  sockets;
  constructor(state, tag) {
    this.state = state;
    this.tag = tag;
  }
  [Symbol.iterator]() {
    return this;
  }
  next() {
    const sockets = this.sockets ?? (this.sockets = this.state.getWebSockets(this.tag));
    let socket;
    while (socket = sockets[this.index++]) if (socket.readyState === WebSocket.READY_STATE_OPEN) {
      if (!isPartyServerWebSocket(socket)) continue;
      return {
        done: false,
        value: createLazyConnection(socket)
      };
    }
    return {
      done: true,
      value: void 0
    };
  }
};
function prepareTags(connectionId, userTags) {
  const tags = [connectionId, ...userTags.filter((t) => t !== connectionId)];
  if (tags.length > 10) throw new Error("A connection can only have 10 tags, including the default id tag.");
  for (const tag of tags) {
    if (typeof tag !== "string") throw new Error(`A connection tag must be a string. Received: ${tag}`);
    if (tag === "") throw new Error("A connection tag must not be an empty string.");
    if (tag.length > 256) throw new Error("A connection tag must not exceed 256 characters");
  }
  return tags;
}
__name(prepareTags, "prepareTags");
var InMemoryConnectionManager = class {
  static {
    __name(this, "InMemoryConnectionManager");
  }
  #connections = /* @__PURE__ */ new Map();
  tags = /* @__PURE__ */ new WeakMap();
  getCount() {
    return this.#connections.size;
  }
  getConnection(id) {
    return this.#connections.get(id);
  }
  *getConnections(tag) {
    if (!tag) {
      yield* this.#connections.values().filter((c) => c.readyState === WebSocket.READY_STATE_OPEN);
      return;
    }
    for (const connection of this.#connections.values()) if ((this.tags.get(connection) ?? []).includes(tag)) yield connection;
  }
  accept(connection, options) {
    try {
      connection.accept({ allowHalfOpen: true });
    } catch {
      connection.accept();
    }
    try {
      connection.binaryType = "arraybuffer";
    } catch {
    }
    const tags = prepareTags(connection.id, options.tags);
    this.#connections.set(connection.id, connection);
    this.tags.set(connection, tags);
    Object.defineProperty(connection, "tags", {
      get: /* @__PURE__ */ __name(() => tags, "get"),
      configurable: true
    });
    const removeConnection = /* @__PURE__ */ __name(() => {
      this.#connections.delete(connection.id);
      connection.removeEventListener("close", removeConnection);
      connection.removeEventListener("error", removeConnection);
    }, "removeConnection");
    connection.addEventListener("close", removeConnection);
    connection.addEventListener("error", removeConnection);
    return connection;
  }
};
var HibernatingConnectionManager = class {
  static {
    __name(this, "HibernatingConnectionManager");
  }
  constructor(controller) {
    this.controller = controller;
  }
  getCount() {
    let count = 0;
    for (const ws of this.controller.getWebSockets()) if (isPartyServerWebSocket(ws)) count++;
    return count;
  }
  getConnection(id) {
    const matching = this.controller.getWebSockets(id).filter((ws) => {
      return tryGetPartyServerMeta(ws)?.id === id;
    });
    if (matching.length === 0) return void 0;
    if (matching.length === 1) return createLazyConnection(matching[0]);
    throw new Error(`More than one connection found for id ${id}. Did you mean to use getConnections(tag) instead?`);
  }
  getConnections(tag) {
    return new HibernatingConnectionIterator(this.controller, tag);
  }
  accept(connection, options) {
    const tags = prepareTags(connection.id, options.tags);
    this.controller.acceptWebSocket(connection, tags);
    connection.serializeAttachment({
      __pk: {
        id: connection.id,
        tags,
        uri: connection.uri ?? void 0
      },
      __user: null
    });
    return createLazyConnection(connection);
  }
};
var CLOSING = 2;
var CLOSED = 3;
function isBenignTeardownError(ws, error) {
  const state = ws.readyState;
  if (state !== CLOSING && state !== CLOSED) return false;
  if (typeof error !== "object" || error === null) return false;
  const typed = error;
  if (typed.retryable === true) return true;
  const message = typeof typed.message === "string" ? typed.message : "";
  return /Network connection lost|WebSocket peer disconnected/i.test(message);
}
__name(isBenignTeardownError, "isBenignTeardownError");
var NAME_STORAGE_KEY = "__ps_name";
function isReservedCloseCode(code) {
  return code === 1005 || code === 1006 || code === 1015;
}
__name(isReservedCloseCode, "isReservedCloseCode");
function closeQuietly(ws, code, reason) {
  if (isReservedCloseCode(code)) return;
  try {
    ws.close(code, reason);
  } catch {
  }
}
__name(closeQuietly, "closeQuietly");
var serverMapCache = /* @__PURE__ */ new WeakMap();
var bindingNameCache = /* @__PURE__ */ new WeakMap();
var DEFAULT_ROUTING_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 800
};
function durableObjectGetOptions(options) {
  return options?.locationHint ? { locationHint: options.locationHint } : void 0;
}
__name(durableObjectGetOptions, "durableObjectGetOptions");
function validatePositiveInteger(value, name) {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be >= 1`);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
}
__name(validatePositiveInteger, "validatePositiveInteger");
function validatePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
}
__name(validatePositiveNumber, "validatePositiveNumber");
function resolveRoutingRetryOptions(options) {
  if (options === false) return null;
  const resolved = {
    maxAttempts: options?.maxAttempts ?? DEFAULT_ROUTING_RETRY_OPTIONS.maxAttempts,
    baseDelayMs: options?.baseDelayMs ?? DEFAULT_ROUTING_RETRY_OPTIONS.baseDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_ROUTING_RETRY_OPTIONS.maxDelayMs,
    onRetry: options?.onRetry
  };
  validatePositiveInteger(resolved.maxAttempts, "routingRetry.maxAttempts");
  validatePositiveNumber(resolved.baseDelayMs, "routingRetry.baseDelayMs");
  validatePositiveNumber(resolved.maxDelayMs, "routingRetry.maxDelayMs");
  if (resolved.baseDelayMs > resolved.maxDelayMs) throw new Error("routingRetry.baseDelayMs must be <= maxDelayMs");
  return resolved;
}
__name(resolveRoutingRetryOptions, "resolveRoutingRetryOptions");
function isRetryableDurableObjectError(error) {
  if (typeof error !== "object" || error === null) return false;
  const typed = error;
  return typed.retryable === true && typed.overloaded !== true;
}
__name(isRetryableDurableObjectError, "isRetryableDurableObjectError");
function routingRetryDelayMs(attempt, options) {
  const upperBoundMs = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * upperBoundMs);
}
__name(routingRetryDelayMs, "routingRetryDelayMs");
async function retryDurableObjectOperation(operation, context, retryOptions) {
  const resolved = resolveRoutingRetryOptions(retryOptions);
  if (!resolved) return await operation();
  let attempt = 1;
  while (true) try {
    return await operation();
  } catch (error) {
    const nextAttempt = attempt + 1;
    if (nextAttempt > resolved.maxAttempts || !isRetryableDurableObjectError(error)) throw error;
    const delayMs = routingRetryDelayMs(attempt, resolved);
    try {
      await resolved.onRetry?.({
        error,
        attempt,
        maxAttempts: resolved.maxAttempts,
        delayMs,
        name: context.name,
        className: context.className
      });
    } catch (callbackError) {
      console.warn("PartyServer routingRetry onRetry callback failed:", callbackError);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt = nextAttempt;
  }
}
__name(retryDurableObjectOperation, "retryDurableObjectOperation");
function encodeProps(props) {
  const bytes = new TextEncoder().encode(JSON.stringify(props));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
__name(encodeProps, "encodeProps");
function decodeProps(header) {
  const trimmed = header.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const binary = atob(header);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}
__name(decodeProps, "decodeProps");
async function getServerByName(serverNamespace, name, options) {
  if (options?.jurisdiction) serverNamespace = serverNamespace.jurisdiction(options.jurisdiction);
  const id = serverNamespace.idFromName(name);
  const getOptions = durableObjectGetOptions(options);
  await retryDurableObjectOperation(() => serverNamespace.get(id, getOptions).setName(name, options?.props), { name }, options?.routingRetry);
  return serverNamespace.get(id, getOptions);
}
__name(getServerByName, "getServerByName");
function camelCaseToKebabCase(str) {
  if (str === str.toUpperCase() && str !== str.toLowerCase()) return str.toLowerCase().replace(/_/g, "-");
  let kebabified = str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}
__name(camelCaseToKebabCase, "camelCaseToKebabCase");
function resolveCorsHeaders(cors) {
  if (cors === true) return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400"
  };
  if (cors && typeof cors === "object") {
    const h = new Headers(cors);
    const record = {};
    h.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return null;
}
__name(resolveCorsHeaders, "resolveCorsHeaders");
async function routePartykitRequest(req, env$1 = env, options) {
  if (!serverMapCache.has(env$1)) {
    const namespaceMap = {};
    const bindingNames2 = {};
    for (const [k, v] of Object.entries(env$1)) if (v && typeof v === "object" && "idFromName" in v && typeof v.idFromName === "function") {
      const kebab = camelCaseToKebabCase(k);
      namespaceMap[kebab] = v;
      bindingNames2[kebab] = k;
    }
    serverMapCache.set(env$1, namespaceMap);
    bindingNameCache.set(env$1, bindingNames2);
  }
  const map = serverMapCache.get(env$1);
  const bindingNames = bindingNameCache.get(env$1);
  const prefixParts = (options?.prefix || "parties").split("/");
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  if (!prefixParts.every((part, index) => parts[index] === part) || parts.length < prefixParts.length + 2) return null;
  const namespace = parts[prefixParts.length];
  const name = parts[prefixParts.length + 1];
  if (name && namespace) {
    let withCorsHeaders = function(response2) {
      if (!corsHeaders || isWebSocket) return response2;
      const newResponse = new Response(response2.body, response2);
      for (const [key, value] of Object.entries(corsHeaders)) newResponse.headers.set(key, value);
      return newResponse;
    };
    __name(withCorsHeaders, "withCorsHeaders");
    if (!map[namespace]) {
      if (namespace === "main") {
        console.warn("You appear to be migrating a PartyKit project to PartyServer.");
        console.warn(`PartyServer doesn't have a "main" party by default. Try adding this to your PartySocket client:
 
party: "${camelCaseToKebabCase(Object.keys(map)[0])}"`);
      } else console.error(`The url ${req.url}  with namespace "${namespace}" and name "${name}" does not match any server namespace. 
Did you forget to add a durable object binding to the class ${namespace[0].toUpperCase() + namespace.slice(1)} in your wrangler.jsonc?`);
      return new Response("Invalid request", { status: 400 });
    }
    const corsHeaders = resolveCorsHeaders(options?.cors);
    const isWebSocket = req.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (req.method === "OPTIONS" && corsHeaders) return new Response(null, { headers: corsHeaders });
    let doNamespace = map[namespace];
    if (options?.jurisdiction) doNamespace = doNamespace.jurisdiction(options.jurisdiction);
    const id = doNamespace.idFromName(name);
    const getOptions = durableObjectGetOptions(options);
    req = new Request(req);
    req.headers.set("x-partykit-namespace", namespace);
    if (options?.jurisdiction) req.headers.set("x-partykit-jurisdiction", options.jurisdiction);
    const className = bindingNames[namespace];
    let partyDeprecationWarned = false;
    const lobby = {
      get party() {
        if (!partyDeprecationWarned) {
          partyDeprecationWarned = true;
          console.warn('lobby.party is deprecated and currently returns the kebab-case namespace (e.g. "my-agent"). Use lobby.className instead to get the Durable Object class name (e.g. "MyAgent"). In the next major version, lobby.party will return the class name.');
        }
        return namespace;
      },
      className,
      name
    };
    if (isWebSocket) {
      if (options?.onBeforeConnect) {
        const reqOrRes = await options.onBeforeConnect(req, lobby);
        if (reqOrRes instanceof Request) req = reqOrRes;
        else if (reqOrRes instanceof Response) return reqOrRes;
      }
    } else if (options?.onBeforeRequest) {
      const reqOrRes = await options.onBeforeRequest(req, lobby);
      if (reqOrRes instanceof Request) req = reqOrRes;
      else if (reqOrRes instanceof Response) return withCorsHeaders(reqOrRes);
    }
    if (options?.props !== void 0) req.headers.set("x-partykit-props", encodeProps(options.props));
    const response = await retryDurableObjectOperation(() => doNamespace.get(id, getOptions).fetch(req.clone()), {
      name,
      className
    }, options?.routingRetry);
    return isWebSocket ? response : withCorsHeaders(response);
  } else return null;
}
__name(routePartykitRequest, "routePartykitRequest");
var Server = class extends DurableObject {
  static {
    __name(this, "Server");
  }
  static options = { hibernate: false };
  #status = "zero";
  #ParentClass = Object.getPrototypeOf(this).constructor;
  #connectionManager = this.#ParentClass.options.hibernate ? new HibernatingConnectionManager(this.ctx) : new InMemoryConnectionManager();
  /**
  * Execute SQL queries against the Server's database
  * @template T Type of the returned rows
  * @param strings SQL query template strings
  * @param values Values to be inserted into the query
  * @returns Array of query results
  */
  sql(strings, ...values) {
    let query = "";
    try {
      query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? "?" : ""), "");
      return [...this.ctx.storage.sql.exec(query, ...values)];
    } catch (e) {
      console.error(`failed to execute sql query: ${query}`, e);
      throw this.onException(e);
    }
  }
  constructor(ctx, env2) {
    super(ctx, env2);
  }
  /**
  * Handle incoming requests to the server.
  */
  async fetch(request) {
    try {
      const props = request.headers.get("x-partykit-props");
      if (props) this.#_props = decodeProps(props);
      if (!this.ctx.id.name && !this.#_name) {
        const room = request.headers.get("x-partykit-room");
        if (room) this.#_name = room;
      }
      await this.#ensureInitialized();
      if (!this.ctx.id.name && !this.#_name) throw new Error(`Cannot determine the name for ${this.#ParentClass.name}: this.ctx.id.name is undefined, no legacy __ps_name storage record is present, and no x-partykit-room header was supplied. Likely causes:
  1. The stub was built via idFromString()/newUniqueId(). PartyServer requires name-based addressing (idFromName/getByName).
  2. The workerd/wrangler runtime is too old to expose ctx.id.name \u2014 update to a recent wrangler release.
  3. You called stub.fetch() directly without going through routePartykitRequest()/getServerByName(). Prefer those, or set the x-partykit-room header.`);
      const url = new URL(request.url);
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return await this.onRequest(request);
      else {
        const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
        let connectionId = url.searchParams.get("_pk");
        if (!connectionId) connectionId = nanoid();
        let connection = Object.assign(serverWebSocket, {
          id: connectionId,
          uri: request.url,
          server: this.name,
          tags: [],
          state: null,
          setState(setState) {
            let state;
            if (setState instanceof Function) state = setState(this.state);
            else state = setState;
            this.state = state;
            return this.state;
          }
        });
        const ctx = { request };
        const tags = await this.getConnectionTags(connection, ctx);
        connection = this.#connectionManager.accept(connection, { tags });
        if (!this.#ParentClass.options.hibernate) this.#attachSocketEventHandlers(connection);
        await this.onConnect(connection, ctx);
        return new Response(null, {
          status: 101,
          webSocket: clientWebSocket
        });
      }
    } catch (err) {
      console.error(`Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} fetch:`, err);
      if (!(err instanceof Error)) throw err;
      if (request.headers.get("Upgrade") === "websocket") {
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].send(JSON.stringify({ error: err.stack }));
        pair[1].close(1011, "Uncaught exception during session setup");
        return new Response(null, {
          status: 101,
          webSocket: pair[0]
        });
      } else return new Response(err.stack, { status: 500 });
    }
  }
  async webSocketMessage(ws, message) {
    if (!isPartyServerWebSocket(ws)) return;
    try {
      const connection = createLazyConnection(ws);
      await this.#ensureInitialized();
      connection.server = this.name;
      return this.onMessage(connection, message);
    } catch (e) {
      console.error(`Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketMessage:`, e);
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    if (!isPartyServerWebSocket(ws)) return;
    try {
      const connection = createLazyConnection(ws);
      await this.#ensureInitialized();
      connection.server = this.name;
      await this.onClose(connection, code, reason, wasClean);
    } catch (e) {
      console.error(`Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketClose:`, e);
    } finally {
      closeQuietly(ws, code, reason);
    }
  }
  async webSocketError(ws, error) {
    if (!isPartyServerWebSocket(ws)) return;
    if (isBenignTeardownError(ws, error)) return;
    try {
      const connection = createLazyConnection(ws);
      await this.#ensureInitialized();
      connection.server = this.name;
      return this.onError(connection, error);
    } catch (e) {
      console.error(`Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketError:`, e);
    }
  }
  /**
  * Read the legacy `__ps_name` storage record as a fallback source of
  * `this.name` when `ctx.id.name` is unavailable. Covers:
  *
  *   1. Alarm handlers firing on alarm records that were scheduled by
  *      a workerd version that did not yet persist `name` into the
  *      alarm record (see the Durable Objects ID docs:
  *      https://developers.cloudflare.com/durable-objects/api/id/#name).
  *      The runtime contract for current workerd populates `ctx.id.name`
  *      in alarm handlers — see the "Raw runtime contract" tests — so
  *      this fallback exists primarily for stale on-disk alarm records
  *      and for defense-in-depth against future runtime changes.
  *   2. Legacy framework-level bootstrap patterns that write
  *      `__ps_name` directly (or call `setName()`) before triggering
  *      `__unsafe_ensureInitialized()` — typically DOs addressed via
  *      `idFromString()` / `newUniqueId()` plus a name override.
  */
  async #hydrateNameFromLegacyStorage() {
    if (this.#_name) return;
    const stored = await this.ctx.storage.get(NAME_STORAGE_KEY);
    if (stored) this.#_name = stored;
  }
  async #persistNameFallbackFromCtxId() {
    const ctxName = this.ctx.id.name;
    if (ctxName === void 0 || this.#_name) return;
    if (await this.ctx.storage.get(NAME_STORAGE_KEY) !== ctxName) await this.ctx.storage.put(NAME_STORAGE_KEY, ctxName);
    this.#_name = ctxName;
  }
  /**
  * @internal — Do not use directly. This is an escape hatch for frameworks
  * (like Agents) that receive calls via native DO RPC, bypassing the
  * standard fetch/alarm/webSocket entry points where initialization
  * normally happens. Calling this from application code is unsupported
  * and may break without notice.
  */
  async __unsafe_ensureInitialized() {
    await this.#ensureInitialized();
  }
  async #ensureInitialized() {
    if (this.#status === "started") return;
    if (this.ctx.id.name !== void 0) await this.#persistNameFallbackFromCtxId();
    else if (!this.#_name) await this.#hydrateNameFromLegacyStorage();
    let error;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.#status = "starting";
      try {
        await this.onStart(this.#_props);
        this.#status = "started";
      } catch (e) {
        this.#status = "zero";
        error = e;
      }
    });
    if (error) throw error;
  }
  #attachSocketEventHandlers(connection) {
    const handleMessageFromClient = /* @__PURE__ */ __name((event) => {
      this.onMessage(connection, event.data)?.catch((e) => {
        console.error("onMessage error:", e);
      });
    }, "handleMessageFromClient");
    const reciprocateClose = /* @__PURE__ */ __name((event) => {
      closeQuietly(connection, event.code, event.reason);
    }, "reciprocateClose");
    const handleCloseFromClient = /* @__PURE__ */ __name((event) => {
      connection.removeEventListener("message", handleMessageFromClient);
      connection.removeEventListener("close", handleCloseFromClient);
      let result;
      try {
        result = this.onClose(connection, event.code, event.reason, event.wasClean);
      } catch (e) {
        console.error("onClose error:", e);
        reciprocateClose(event);
        return;
      }
      if (result && typeof result.then === "function") result.catch((e) => {
        console.error("onClose error:", e);
      }).finally(() => reciprocateClose(event));
      else reciprocateClose(event);
    }, "handleCloseFromClient");
    const handleErrorFromClient = /* @__PURE__ */ __name((e) => {
      connection.removeEventListener("message", handleMessageFromClient);
      connection.removeEventListener("error", handleErrorFromClient);
      if (isBenignTeardownError(connection, e.error)) return;
      this.onError(connection, e.error)?.catch((err) => {
        console.error("onError error:", err);
      });
    }, "handleErrorFromClient");
    connection.addEventListener("close", handleCloseFromClient);
    connection.addEventListener("error", handleErrorFromClient);
    connection.addEventListener("message", handleMessageFromClient);
  }
  #_name;
  /**
  * The name for this server.
  *
  * Resolves from `this.ctx.id.name` — the native DO id name, populated
  * whenever the stub was created via `idFromName()` or `getByName()`.
  * This is available inside every entry point (including the constructor,
  * alarms, and hibernating websocket handlers).
  *
  * For alarm handlers firing on stale on-disk alarm records from
  * older workerd versions that didn't persist `name` into the alarm
  * record, the name is recovered from a storage fallback record.
  *
  * Throws if neither source is available — typically this means the DO
  * was addressed via `idFromString()` or `newUniqueId()`, which is not
  * supported by PartyServer.
  */
  get name() {
    const ctxName = this.ctx.id.name;
    if (ctxName !== void 0) return ctxName;
    if (this.#_name) return this.#_name;
    throw new Error(`Attempting to read .name on ${this.#ParentClass.name}, but this.ctx.id.name is not set and no ${NAME_STORAGE_KEY} fallback record is available. PartyServer requires DOs to be addressed via idFromName()/getByName(), or explicitly bootstrapped with setName() when using idFromString()/newUniqueId(). If this happens in an alarm handler firing on a stale alarm record, initialize the DO from a fetch/RPC entry point first so PartyServer can persist the fallback name.`);
  }
  /**
  * Establish this server's name and trigger `onStart()`.
  *
  * Use cases:
  *
  *   1. **Framework-level bootstrap of DOs where `ctx.id.name` is
  *      undefined** — e.g. DOs addressed via `idFromString()` /
  *      `newUniqueId()`. `setName()` stashes the name in memory and
  *      persists it under `__ps_name` so cold-wake invocations
  *      recover it via `#ensureInitialized()`'s legacy fallback.
  *   2. **Delivering initial `props` to `onStart()`** via the
  *      optional second argument.
  *
  * For DOs addressed via `idFromName()` / `getByName()`, calling
  * `setName()` is redundant — `this.name` is available automatically
  * from `ctx.id.name`. The normal initialization path also persists
  * a fallback record so old-compat alarm handlers can recover the name.
  * Throws if `name` does not match `ctx.id.name`.
  *
  * **Not appropriate for facets.** Cloudflare Agents and any other
  * framework using `ctx.facets.get(...)` should pass an explicit
  * `id` in `FacetStartupOptions` so the facet has its own
  * `ctx.id.name`:
  *
  * ```ts
  * const stub = ctx.facets.get(facetKey, () => ({
  *   class: ChildClass,
  *   id: ctx.exports.SomeBoundDOClass.idFromName(facetName),
  * }));
  * ```
  *
  * Without an explicit `id`, the facet inherits the parent DO's
  * `ctx.id` (including `ctx.id.name`), and `setName()` will throw
  * the ctx.id.name-mismatch error because the facet's intended
  * name differs from the parent's. See
  * https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
  * for the `FacetStartupOptions.id` semantics.
  *
  * @deprecated for callers that address DOs via `idFromName()` /
  * `getByName()`. Still the supported API for framework-level
  * bootstrap of header/`newUniqueId`-addressed DOs and for
  * delivering initial `props` to `onStart()`.
  */
  async setName(name, props) {
    if (!name) throw new Error("A name is required.");
    const ctxName = this.ctx.id.name;
    if (ctxName !== void 0 && ctxName !== name) throw new Error(`This server's Durable Object id was created for name "${ctxName}", cannot setName to "${name}".`);
    if (this.#_name && this.#_name !== name) throw new Error(`This server already has a name: ${this.#_name}, attempting to set to: ${name}`);
    if (props !== void 0) this.#_props = props;
    if (!this.#_name && ctxName === void 0) {
      await this.ctx.storage.put(NAME_STORAGE_KEY, name);
      this.#_name = name;
    }
    await this.#ensureInitialized();
  }
  /**
  * @internal
  * @deprecated Retained for backward compatibility with older callers.
  * `routePartykitRequest` no longer uses this method; it sends props via
  * the `x-partykit-props` header on the underlying `fetch()` request.
  */
  async _initAndFetch(name, props, request) {
    await this.setName(name, props);
    return this.fetch(request);
  }
  #sendMessageToConnection(connection, message) {
    try {
      connection.send(message);
    } catch (_e) {
      connection.close(1011, "Unexpected error");
    }
  }
  /** Send a message to all connected clients, except connection ids listed in `without` */
  broadcast(msg, without) {
    for (const connection of this.#connectionManager.getConnections()) if (!without || !without.includes(connection.id)) this.#sendMessageToConnection(connection, msg);
  }
  /** Get a connection by connection id */
  getConnection(id) {
    return this.#connectionManager.getConnection(id);
  }
  /**
  * Get all connections. Optionally, you can provide a tag to filter returned connections.
  * Use `Server#getConnectionTags` to tag the connection on connect.
  */
  getConnections(tag) {
    return this.#connectionManager.getConnections(tag);
  }
  /**
  * You can tag a connection to filter them in Server#getConnections.
  * Each connection supports up to 9 tags, each tag max length is 256 characters.
  */
  getConnectionTags(connection, context) {
    return [];
  }
  #_props;
  /**
  * Called when the server is started for the first time.
  */
  onStart(props) {
  }
  /**
  * Called when a new connection is made to the server.
  */
  onConnect(connection, ctx) {
  }
  /**
  * Called when a message is received from a connection.
  */
  onMessage(connection, message) {
  }
  /**
  * Called when a connection is closed.
  */
  onClose(connection, code, reason, wasClean) {
  }
  /**
  * Called when an error occurs on a connection.
  */
  onError(connection, error) {
    console.error(`Error on connection ${connection.id} in ${this.#ParentClass.name}:${this.name}:`, error);
    console.info(`Implement onError on ${this.#ParentClass.name} to handle this error.`);
  }
  /**
  * Called when a request is made to the server.
  */
  onRequest(request) {
    console.warn(`onRequest hasn't been implemented on ${this.#ParentClass.name}:${this.name} responding to ${request.url}`);
    return new Response("Not implemented", { status: 404 });
  }
  /**
  * Called when an exception occurs.
  * @param error - The error that occurred.
  */
  onException(error) {
    console.error(`Exception in ${this.#ParentClass.name}:${this.name}:`, error);
    console.info(`Implement onException on ${this.#ParentClass.name} to handle this error.`);
  }
  onAlarm() {
    console.log(`Implement onAlarm on ${this.#ParentClass.name} to handle alarms.`);
  }
  async alarm() {
    await this.#ensureInitialized();
    await this.onAlarm();
  }
};

// src/game/rules.ts
var DEFAULT_GRAVITY_CELLS_PER_FRAME = 1 / 60;
var DEFAULT_SOFT_DROP_FACTOR = 40;
var INSTANT_SOFT_DROP_FACTOR = 41;
var INSTANT_SOFT_DROP_CELLS = 60;
function softDropCellsPerFrameForFactor(factor) {
  if (factor >= INSTANT_SOFT_DROP_FACTOR) return INSTANT_SOFT_DROP_CELLS;
  return DEFAULT_GRAVITY_CELLS_PER_FRAME * (factor - 1);
}
__name(softDropCellsPerFrameForFactor, "softDropCellsPerFrameForFactor");
var DEFAULT_RULES = {
  boardWidth: 10,
  visibleRows: 20,
  // Buffer estilo tetr.io: campo de 40 de alto (20 visibles + 20 ocultas). La pila
  // puede crecer dentro del buffer sin morir; solo matan block-out (la pieza no
  // entra en el spawn) y lock-out (se fija entera sobre el techo). No hay muerte
  // por tiempo: apilar arriba está permitido mientras sigan apareciendo piezas.
  hiddenRows: 20,
  nextPreview: 5,
  targetLines: 40,
  attackTable: "simple",
  gravityCellsPerFrame: DEFAULT_GRAVITY_CELLS_PER_FRAME,
  gravityIncreaseCellsPerLevel: 0,
  gravityLevelLines: 0,
  gravityLevelPieces: 0,
  gravityStartingLevel: 1,
  softDropCellsPerFrame: softDropCellsPerFrameForFactor(DEFAULT_SOFT_DROP_FACTOR),
  lockDelayFrames: 30,
  dasFrames: 8,
  arrFrames: 2,
  garbageDelayFrames: 90,
  garbageTravelFrames: 0,
  garbageActivationFrames: 90,
  garbageCap: 0,
  garbageMessinessPercent: 100,
  changeOnAttack: true,
  continuousGarbage: false,
  allowHardDrop: true,
  allowHold: true,
  showGhost: true,
  infiniteHold: false,
  infiniteMovement: false,
  lockResetLimit: 15
};
var BATTLE_RULES = {
  ...DEFAULT_RULES,
  targetLines: null,
  // En batallas online los combos, B2B y spins suman ataque (tabla moderna).
  attackTable: "modern",
  // La gravedad acelera como en TETR.IO: sube un nivel de la curva guideline cada
  // 10 líneas, así las partidas largas se vuelven más rápidas.
  gravityCurve: "guideline",
  gravityLevelLines: 10
};

// src/online/roomService.ts
var ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var ROOM_CODE_LENGTH = 4;
var ROOM_ID_MIN_LENGTH = 4;
var ROOM_ID_MAX_LENGTH = 64;
var ROOM_START_DELAY_MS = 5e3;
var PLAYER_STALE_MS = 1e4;
var HOST_STALE_MS = 15e3;
var HOST_UNREACHABLE_MS = 6e3;
var ROOM_ABANDONED_MS = 3e4;
var PRESENCE_REFRESH_MS = 6e3;
var ROOM_TTL_SECONDS = 2 * 60 * 60;
var MAX_PEER_SIGNALS_PER_ROOM = 200;
var MAX_ATTACKS_PER_ROOM = 300;
var ONLINE_RULESET_VERSION = 1;
var TARGETING_MODES = ["manual", "random", "even", "ko", "attackers"];
var DEFAULT_ONLINE_REGION = "gru1";
var OnlineRoomError = class extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
  static {
    __name(this, "OnlineRoomError");
  }
};
var RoomVersionConflictError = class extends OnlineRoomError {
  static {
    __name(this, "RoomVersionConflictError");
  }
  constructor() {
    super("Room was modified concurrently.", 409);
  }
};
var ROOM_MUTATION_ATTEMPTS = 6;
async function withRoomConflictRetry(mutation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await mutation();
    } catch (error) {
      if (!(error instanceof RoomVersionConflictError) || attempt >= ROOM_MUTATION_ATTEMPTS) throw error;
    }
  }
}
__name(withRoomConflictRetry, "withRoomConflictRetry");
function retryRoomConflicts(mutation) {
  return (...args) => withRoomConflictRetry(() => mutation(...args));
}
__name(retryRoomConflicts, "retryRoomConflicts");
var createRoom = retryRoomConflicts(createRoomOnce);
var enterLunaNegraRoom = retryRoomConflicts(enterLunaNegraRoomOnce);
var joinRoom = retryRoomConflicts(joinRoomOnce);
var setPlayerReady = retryRoomConflicts(setPlayerReadyOnce);
var startRoom = retryRoomConflicts(startRoomOnce);
var restartRoom = retryRoomConflicts(restartRoomOnce);
var reopenRoom = retryRoomConflicts(reopenRoomOnce);
var updateRoomSettings = retryRoomConflicts(updateRoomSettingsOnce);
var leaveRoom = retryRoomConflicts(leaveRoomOnce);
var kickPlayer = retryRoomConflicts(kickPlayerOnce);
var setPlayerTargeting = retryRoomConflicts(setPlayerTargetingOnce);
var updateProgress = retryRoomConflicts(updateProgressOnce);
var submitResult = retryRoomConflicts(submitResultOnce);
var addAttack = retryRoomConflicts(addAttackOnce);
var eliminatePlayer = retryRoomConflicts(eliminatePlayerOnce);
var getRoomState = retryRoomConflicts(getRoomStateOnce);
var requestHostFailover = retryRoomConflicts(requestHostFailoverOnce);
var addPeerSignal = retryRoomConflicts(addPeerSignalOnce);
var setRoomBet = retryRoomConflicts(setRoomBetOnce);
async function createRoomOnce(store, request, nowMs = Date.now()) {
  const player = createPlayer(request.playerId, request.name, nowMs, request.avatarUrl, request.npub);
  const id = request.roomId ? normalizeRoomIdStrict(request.roomId) : await generateUniqueRoomId((candidate) => store.getRoom(candidate));
  if (await store.getRoom(id)) throw new OnlineRoomError("Room already exists.", 409);
  const mode = normalizeRoomMode(request.mode, true);
  const matchType = normalizeMatchType(request.matchType, mode, true);
  const ruleset = normalizeRuleset(request.ruleset, matchType, true);
  const room = {
    id,
    visibility: normalizeVisibility(request.visibility),
    mode,
    matchType,
    region: normalizeRegion(request.region),
    ruleset,
    rules: normalizeRoomRules(request.rules, mode, ruleset),
    status: "lobby",
    hostPlayerId: player.id,
    createdAtServerMs: nowMs,
    updatedAtServerMs: nowMs,
    startsAtServerMs: null,
    seed: randomSeed(),
    winnerPlayerId: null,
    matchResultId: null,
    players: [player],
    peerSignals: [],
    attacks: [],
    bet: null,
    lunaGameId: normalizeNullableString(request.lunaGameId)
  };
  await persistRoom(store, room);
  return room;
}
__name(createRoomOnce, "createRoomOnce");
async function enterLunaNegraRoomOnce(store, invite, nowMs = Date.now()) {
  const player = lunaNegraPlayerFromInvite(invite);
  const roomId = normalizeRoomIdStrict(invite.roomId);
  const existing = await store.getRoom(roomId).then((value) => value ? normalizeRoomShape(value) : null);
  if (existing) {
    if (invite.hostPubkey && existing.hostPlayerId !== invite.hostPubkey) {
      throw new OnlineRoomError("Luna Negra host does not match this room.", 403);
    }
    if (invite.host && existing.hostPlayerId !== player.id) {
      throw new OnlineRoomError("Only the original Luna Negra host can reopen this room.", 403);
    }
    if (invite.gameId && !existing.lunaGameId) existing.lunaGameId = normalizeNullableString(invite.gameId);
    const room2 = await enterExistingLunaNegraRoom(store, existing, player, nowMs);
    return { room: room2, player };
  }
  const room = await createLunaNegraRoomFromInvite(store, roomId, invite, player, nowMs);
  return { room, player };
}
__name(enterLunaNegraRoomOnce, "enterLunaNegraRoomOnce");
async function createLunaNegraRoomFromInvite(store, roomId, invite, player, nowMs) {
  const mode = "custom";
  const matchType = "battle";
  const ruleset = normalizeRuleset(void 0, matchType);
  const hostPlayerId = invite.host ? player.id : normalizeLunaNegraHostPlayerId(invite.hostPubkey);
  const hostPlayer = invite.host ? createPlayer(player.id, player.name, nowMs, player.avatarUrl, player.npub) : createPendingLunaNegraHost(hostPlayerId, nowMs);
  const players = hostPlayer.id === player.id ? [hostPlayer] : [hostPlayer, createPlayer(player.id, player.name, nowMs, player.avatarUrl, player.npub)];
  const room = {
    id: roomId,
    visibility: "private",
    mode,
    matchType,
    region: DEFAULT_ONLINE_REGION,
    ruleset,
    rules: normalizeRoomRules(BATTLE_RULES, mode, ruleset),
    status: "lobby",
    hostPlayerId,
    createdAtServerMs: nowMs,
    updatedAtServerMs: nowMs,
    startsAtServerMs: null,
    seed: randomSeed(),
    winnerPlayerId: null,
    matchResultId: null,
    players,
    peerSignals: [],
    attacks: [],
    bet: null,
    lunaGameId: normalizeNullableString(invite.gameId)
  };
  await persistRoom(store, room);
  return room;
}
__name(createLunaNegraRoomFromInvite, "createLunaNegraRoomFromInvite");
function normalizeLunaNegraHostPlayerId(hostPubkey) {
  if (!hostPubkey) throw new OnlineRoomError("Luna Negra invite is missing host pubkey.", 400);
  return normalizePlayerId(hostPubkey);
}
__name(normalizeLunaNegraHostPlayerId, "normalizeLunaNegraHostPlayerId");
function createPendingLunaNegraHost(hostPlayerId, nowMs) {
  const player = createPlayer(hostPlayerId, "Host", nowMs);
  player.status = "disconnected";
  return player;
}
__name(createPendingLunaNegraHost, "createPendingLunaNegraHost");
async function joinRoomOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  if (room.status !== "lobby") throw new OnlineRoomError("Room already started.", 409);
  const player = createPlayer(request.playerId, request.name, nowMs, request.avatarUrl, request.npub);
  const existing = room.players.find((candidate) => candidate.id === player.id);
  if (existing) {
    existing.name = player.name;
    if (request.avatarUrl !== void 0) existing.avatarUrl = player.avatarUrl;
    if (player.npub) existing.npub = player.npub;
    existing.updatedAtServerMs = nowMs;
    existing.status = existing.ready ? "ready" : "joined";
  } else {
    room.players.push(player);
  }
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(joinRoomOnce, "joinRoomOnce");
async function setPlayerReadyOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  if (room.status !== "lobby") throw new OnlineRoomError("Room already started.", 409);
  const player = requirePlayer(room, request.playerId);
  player.ready = request.ready;
  player.status = request.ready ? "ready" : "joined";
  player.updatedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(setPlayerReadyOnce, "setPlayerReadyOnce");
async function startRoomOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError("Only the host can start.", 403);
  if (room.status !== "lobby") return room;
  const ready = room.players.filter((player) => isRoundReady(player, nowMs));
  if (!ready.some((player) => player.id === room.hostPlayerId)) {
    throw new OnlineRoomError("El host tiene que estar listo para empezar.", 409);
  }
  if (room.players.length > 1 && ready.length < 2) {
    throw new OnlineRoomError("Se necesitan al menos dos jugadores listos para empezar.", 409);
  }
  if (room.bet && room.bet.status !== "funded") {
    throw new OnlineRoomError("La apuesta todav\xEDa no est\xE1 fondeada por todos los jugadores.", 409);
  }
  prepareRoundCountdown(room, nowMs, false);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(startRoomOnce, "startRoomOnce");
async function restartRoomOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError("Only the host can restart.", 403);
  if (room.status !== "finished") return room;
  if (room.bet) {
    if (!isTerminalRoomBetStatus(room.bet.status)) {
      throw new OnlineRoomError("La apuesta todav\xEDa no termin\xF3 de liquidarse.", 409);
    }
    room.bet = null;
  }
  room.matchResultId = null;
  prepareRoundCountdown(room, nowMs, true);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(restartRoomOnce, "restartRoomOnce");
async function reopenRoomOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError("Only the host can reopen the room.", 403);
  if (room.status !== "finished") return room;
  if (room.bet && !isTerminalRoomBetStatus(room.bet.status)) return room;
  room.bet = null;
  room.status = "lobby";
  room.startsAtServerMs = null;
  room.winnerPlayerId = null;
  room.matchResultId = null;
  room.seed = randomSeed();
  room.attacks = [];
  room.peerSignals = [];
  room.players = room.players.map((player) => ({
    ...player,
    ready: true,
    status: "ready",
    lines: 0,
    pieces: 0,
    elapsedFrames: 0,
    sentGarbage: 0,
    receivedGarbage: 0,
    pendingGarbage: 0,
    alive: true,
    finishedAtServerMs: null,
    eliminatedAtFrame: null,
    eliminatedAtServerMs: null,
    game: null,
    currentTargetPlayerId: null,
    recentAttackers: [],
    receivedGarbageThisRound: 0,
    dangerLevel: 0,
    updatedAtServerMs: nowMs
  }));
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(reopenRoomOnce, "reopenRoomOnce");
async function updateRoomSettingsOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError("Only the host can change room settings.", 403);
  if (room.status !== "lobby") throw new OnlineRoomError("Room settings can only change in the lobby.", 409);
  if (request.visibilityOnly) {
    room.visibility = normalizeVisibility(request.visibility ?? room.visibility);
    room.updatedAtServerMs = nowMs;
    await persistRoom(store, room);
    return room;
  }
  if (room.bet && !isTerminalRoomBetStatus(room.bet.status)) {
    throw new OnlineRoomError("No se puede cambiar el modo con una apuesta activa.", 409);
  }
  const mode = normalizeRoomMode(request.mode, true);
  const matchType = normalizeMatchType(request.matchType, mode, true);
  const ruleset = normalizeRuleset(request.ruleset, matchType, true);
  room.visibility = normalizeVisibility(request.visibility ?? room.visibility);
  room.mode = "custom";
  room.matchType = matchType;
  room.ruleset = ruleset;
  room.rules = normalizeRoomRules(request.rules, room.mode, ruleset);
  room.winnerPlayerId = null;
  room.matchResultId = null;
  room.startsAtServerMs = null;
  room.attacks = [];
  room.players = room.players.map((player) => ({
    ...player,
    // Auto-ready: cambiar ajustes no obliga a todos a volver a marcarse listos.
    ready: true,
    status: "ready",
    updatedAtServerMs: nowMs
  }));
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(updateRoomSettingsOnce, "updateRoomSettingsOnce");
async function leaveRoomOnce(store, request, nowMs = Date.now()) {
  const room = await store.getRoom(normalizeRoomId(request.roomId)).then((value) => value ? normalizeRoomShape(value) : null);
  if (!room) return { room: null, hostMigratedTo: null };
  const before = room.players.length;
  room.players = room.players.filter((player) => player.id !== request.playerId);
  if (room.players.length === before) {
    return { room, hostMigratedTo: null };
  }
  if (room.players.length === 0) {
    await removeRoomEverywhere(store, room.id);
    return { room: null, hostMigratedTo: null };
  }
  const hostMigratedTo = migrateHostIfNeeded(room);
  if (room.status === "playing" || room.status === "countdown") {
    if (room.players.length === 1) {
      const winner = room.players[0];
      winner.status = "winner";
      winner.alive = true;
      winner.finishedAtServerMs = nowMs;
      winner.updatedAtServerMs = nowMs;
      room.winnerPlayerId = winner.id;
      room.status = "finished";
      sealMatchResult(room, nowMs);
    } else {
      finishRoomIfOnlyOneAlive(room, nowMs);
    }
  }
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return { room, hostMigratedTo };
}
__name(leaveRoomOnce, "leaveRoomOnce");
async function kickPlayerOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  if (room.hostPlayerId !== request.playerId) throw new OnlineRoomError("Solo el host puede expulsar jugadores.", 403);
  if (request.targetPlayerId === room.hostPlayerId) throw new OnlineRoomError("El host no puede expulsarse a s\xED mismo.", 409);
  if (room.status !== "lobby") throw new OnlineRoomError("Solo se puede expulsar en el lobby.", 409);
  const before = room.players.length;
  room.players = room.players.filter((player) => player.id !== request.targetPlayerId);
  if (room.players.length === before) throw new OnlineRoomError("El jugador no est\xE1 en la sala.", 404);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(kickPlayerOnce, "kickPlayerOnce");
function migrateHostIfNeeded(room) {
  if (room.players.some((player) => player.id === room.hostPlayerId)) return null;
  const next = room.players[0];
  if (!next) return null;
  room.hostPlayerId = next.id;
  return next.id;
}
__name(migrateHostIfNeeded, "migrateHostIfNeeded");
async function removeRoomEverywhere(store, roomId) {
  await store.deleteRoom(roomId);
  const publicIds = await store.listPublicRoomIds();
  if (publicIds.includes(roomId)) {
    await store.savePublicRoomIds(publicIds.filter((id) => id !== roomId), ROOM_TTL_SECONDS);
  }
}
__name(removeRoomEverywhere, "removeRoomEverywhere");
async function setPlayerTargetingOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  const player = requirePlayer(room, request.playerId);
  const targetingMode = normalizeTargetingMode(request.targetingMode, true);
  const manualTargetPlayerId = normalizeManualTarget(room, player.id, request.manualTargetPlayerId);
  player.targetingMode = targetingMode;
  player.manualTargetPlayerId = targetingMode === "manual" ? manualTargetPlayerId : null;
  player.currentTargetPlayerId = targetingMode === "manual" ? manualTargetPlayerId : player.currentTargetPlayerId;
  player.updatedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(setPlayerTargetingOnce, "setPlayerTargetingOnce");
async function updateProgressOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  const isSelfReport = request.authorityPlayerId !== room.hostPlayerId && request.authorityPlayerId === request.playerId;
  if (!isSelfReport) requireHostAuthority(room, request.authorityPlayerId);
  if (!requestMatchesRoomSeed(room, request.seed)) return room;
  const player = requirePlayer(room, request.playerId);
  if (isTerminalPlayer(player)) {
    if (!isSelfReport && (room.status === "playing" || room.status === "countdown")) {
      room.updatedAtServerMs = nowMs;
      await persistRoom(store, room);
    }
    return room;
  }
  if (!isSelfReport && room.status === "countdown" && room.startsAtServerMs !== null && nowMs >= room.startsAtServerMs) {
    room.status = "playing";
  }
  player.status = player.alive ? "playing" : player.status;
  player.lines = normalizeNonNegativeInteger(request.lines);
  player.pieces = normalizeNonNegativeInteger(request.pieces);
  player.elapsedFrames = normalizeNonNegativeInteger(request.elapsedFrames);
  player.sentGarbage = normalizeNonNegativeInteger(request.sentGarbage ?? player.sentGarbage);
  player.receivedGarbage = normalizeNonNegativeInteger(request.receivedGarbage ?? player.receivedGarbage);
  player.pendingGarbage = normalizeNonNegativeInteger(request.pendingGarbage ?? player.pendingGarbage);
  player.game = request.game ?? null;
  player.dangerLevel = calculateDangerLevel(player.game, player.pendingGarbage);
  player.updatedAtServerMs = nowMs;
  if (!isSelfReport) room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(updateProgressOnce, "updateProgressOnce");
async function submitResultOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  requireSelfOrHostAuthority(room, request.authorityPlayerId, request.playerId);
  if (!requestMatchesRoomSeed(room, request.seed)) return room;
  const player = requirePlayer(room, request.playerId);
  if (isTerminalPlayer(player)) return room;
  player.status = request.result;
  player.ready = true;
  player.alive = request.result === "won";
  player.lines = normalizeNonNegativeInteger(request.lines);
  player.pieces = normalizeNonNegativeInteger(request.pieces);
  player.elapsedFrames = normalizeNonNegativeInteger(request.elapsedFrames);
  player.sentGarbage = normalizeNonNegativeInteger(request.sentGarbage ?? player.sentGarbage);
  player.receivedGarbage = normalizeNonNegativeInteger(request.receivedGarbage ?? player.receivedGarbage);
  player.pendingGarbage = normalizeNonNegativeInteger(request.pendingGarbage ?? player.pendingGarbage);
  player.game = request.game ?? null;
  player.dangerLevel = calculateDangerLevel(player.game, player.pendingGarbage);
  player.updatedAtServerMs = nowMs;
  player.finishedAtServerMs = nowMs;
  room.updatedAtServerMs = nowMs;
  if (room.ruleset.objective.type === "sprint" && request.result === "won") {
    finishSprintRace(room, player, nowMs);
  } else if (room.players.every((candidate) => candidate.status === "won" || candidate.status === "lost")) {
    room.status = "finished";
    room.winnerPlayerId = rankPlayers(room.players).find((candidate) => candidate.status === "won")?.id ?? null;
    sealMatchResult(room, nowMs);
  }
  await persistRoom(store, room);
  return room;
}
__name(submitResultOnce, "submitResultOnce");
async function addAttackOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  requireSelfOrHostAuthority(room, request.authorityPlayerId, request.fromPlayerId);
  if (!requestMatchesRoomSeed(room, request.seed)) return room;
  const from = requirePlayer(room, request.fromPlayerId);
  const to = requirePlayer(room, request.toPlayerId);
  if (!from.alive || !to.alive || room.status === "finished") return room;
  const id = normalizeAttackId(request.attackId);
  if ((room.attacks ?? []).some((attack2) => attack2.id === id)) return room;
  const attack = {
    id,
    roomId: room.id,
    // El autor de registro es siempre la fuente (no el host que pudiera relayar):
    // los clientes validan el garbage entrante con authorityPlayerId === fromPlayerId.
    authorityPlayerId: from.id,
    fromPlayerId: from.id,
    toPlayerId: to.id,
    seed: request.seed,
    lines: normalizeNonNegativeInteger(request.lines),
    holeSeed: normalizeNonNegativeInteger(request.holeSeed),
    frame: normalizeNonNegativeInteger(request.frame),
    createdAtServerMs: nowMs
  };
  if (attack.lines <= 0) return room;
  from.currentTargetPlayerId = to.id;
  to.recentAttackers = prependUnique(to.recentAttackers ?? [], from.id, 8);
  to.receivedGarbageThisRound = normalizeNonNegativeInteger((to.receivedGarbageThisRound ?? 0) + attack.lines);
  room.attacks = [...room.attacks ?? [], attack].slice(-MAX_ATTACKS_PER_ROOM);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(addAttackOnce, "addAttackOnce");
async function eliminatePlayerOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  requireSelfOrHostAuthority(room, request.authorityPlayerId, request.playerId);
  if (!requestMatchesRoomSeed(room, request.seed)) return room;
  const player = requirePlayer(room, request.playerId);
  if (player.status === "winner" || room.winnerPlayerId === player.id) return room;
  if (player.status !== "eliminated") {
    player.status = "eliminated";
    player.ready = true;
    player.alive = false;
    player.eliminatedAtFrame = normalizeNonNegativeInteger(request.frame);
    player.eliminatedAtServerMs = nowMs;
    player.finishedAtServerMs = nowMs;
    const lastAttackerId = player.recentAttackers[0];
    const lastAttacker = lastAttackerId ? room.players.find((candidate) => candidate.id === lastAttackerId) : null;
    if (lastAttacker && lastAttacker.id !== player.id) {
      lastAttacker.koCount = normalizeNonNegativeInteger((lastAttacker.koCount ?? 0) + 1);
    }
  }
  player.lines = normalizeNonNegativeInteger(request.lines);
  player.pieces = normalizeNonNegativeInteger(request.pieces);
  player.elapsedFrames = normalizeNonNegativeInteger(request.elapsedFrames);
  player.sentGarbage = normalizeNonNegativeInteger(request.sentGarbage ?? player.sentGarbage);
  player.receivedGarbage = normalizeNonNegativeInteger(request.receivedGarbage ?? player.receivedGarbage);
  player.pendingGarbage = normalizeNonNegativeInteger(request.pendingGarbage ?? player.pendingGarbage);
  player.game = request.game ?? null;
  player.dangerLevel = calculateDangerLevel(player.game, player.pendingGarbage);
  player.updatedAtServerMs = nowMs;
  finishRoomIfOnlyOneAlive(room, nowMs);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(eliminatePlayerOnce, "eliminatePlayerOnce");
function isRoomAbandoned(room, nowMs) {
  if (room.players.length === 0) return true;
  return room.players.every((player) => nowMs - player.updatedAtServerMs > ROOM_ABANDONED_MS);
}
__name(isRoomAbandoned, "isRoomAbandoned");
async function getRoomStateOnce(store, roomId, nowMs = Date.now(), presencePlayerId) {
  const room = await requireRoom(store, roomId);
  let changed = false;
  let needsPersist = false;
  if (presencePlayerId) {
    const member = room.players.find((player) => player.id === presencePlayerId);
    if (member && nowMs - member.updatedAtServerMs >= PRESENCE_REFRESH_MS) {
      member.updatedAtServerMs = nowMs;
      needsPersist = true;
    }
  }
  if (room.status === "lobby") {
    for (const player of room.players) {
      if (player.ready && isPlayerStale(player, nowMs)) {
        player.ready = false;
        player.status = "joined";
        needsPersist = true;
      }
    }
  }
  if (room.status === "countdown" && room.startsAtServerMs !== null && nowMs >= room.startsAtServerMs) {
    room.status = "playing";
    changed = true;
  }
  if (applyHostFailover(room, nowMs)) changed = true;
  if (isRoomAbandoned(room, nowMs)) {
    await removeRoomEverywhere(store, room.id);
    throw new OnlineRoomError("Room not found.", 404);
  }
  if (changed) {
    room.updatedAtServerMs = nowMs;
    needsPersist = true;
  }
  if (needsPersist) await persistRoom(store, room);
  return applyStalePlayers(room, nowMs);
}
__name(getRoomStateOnce, "getRoomStateOnce");
async function requestHostFailoverOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  const requester = room.players.find((player) => player.id === request.playerId);
  if (requester && requester.id !== room.hostPlayerId && requester.alive && !isTerminalPlayer(requester) && applyHostFailover(room, nowMs, HOST_UNREACHABLE_MS)) {
    await persistRoom(store, room);
  }
  return applyStalePlayers(room, nowMs);
}
__name(requestHostFailoverOnce, "requestHostFailoverOnce");
async function addPeerSignalOnce(store, request, nowMs = Date.now()) {
  const room = await requireRoom(store, request.roomId);
  requirePlayer(room, request.fromPlayerId);
  requirePlayer(room, request.toPlayerId);
  const signal = {
    id: `${nowMs}-${Math.random().toString(36).slice(2, 10)}`,
    roomId: room.id,
    fromPlayerId: request.fromPlayerId,
    toPlayerId: request.toPlayerId,
    type: normalizePeerSignalType(request.type),
    data: request.data,
    createdAtServerMs: nowMs
  };
  room.peerSignals = [...room.peerSignals ?? [], signal].slice(-MAX_PEER_SIGNALS_PER_ROOM);
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(addPeerSignalOnce, "addPeerSignalOnce");
function rankPlayers(players) {
  return [...players].sort((a, b) => {
    const resultDelta = resultRank(a.status) - resultRank(b.status);
    if (resultDelta !== 0) return resultDelta;
    if (a.status === "eliminated" && b.status === "eliminated") {
      const frameDelta = (b.eliminatedAtFrame ?? b.elapsedFrames) - (a.eliminatedAtFrame ?? a.elapsedFrames);
      if (frameDelta !== 0) return frameDelta;
    }
    if (a.status === "won" && b.status === "won") return a.elapsedFrames - b.elapsedFrames;
    if (a.status === "lost" && b.status === "lost") return b.lines - a.lines;
    const finishedDelta = (a.finishedAtServerMs ?? Number.MAX_SAFE_INTEGER) - (b.finishedAtServerMs ?? Number.MAX_SAFE_INTEGER);
    if (finishedDelta !== 0) return finishedDelta;
    return a.name.localeCompare(b.name);
  });
}
__name(rankPlayers, "rankPlayers");
function calculateDangerLevel(game, pendingGarbage) {
  const pendingDanger = Math.min(10, Math.floor(normalizeNonNegativeInteger(pendingGarbage) / 2));
  if (!game || !Array.isArray(game.board) || game.board.length === 0) return pendingDanger;
  const visibleRows = Math.max(1, Math.min(normalizeNonNegativeInteger(game.visibleRows), game.board.length));
  const visibleBoard = game.board.slice(game.board.length - visibleRows);
  const firstOccupiedRow = visibleBoard.findIndex((row) => Array.isArray(row) && row.some((cell) => cell !== null));
  const heightDanger = firstOccupiedRow === -1 ? 0 : Math.ceil((visibleRows - firstOccupiedRow) / visibleRows * 10);
  return Math.min(10, Math.max(heightDanger, pendingDanger));
}
__name(calculateDangerLevel, "calculateDangerLevel");
async function generateUniqueRoomId(getExistingRoom) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = createRoomCode();
    if (!await getExistingRoom(id)) return id;
  }
  throw new OnlineRoomError("Could not allocate a room code.", 503);
}
__name(generateUniqueRoomId, "generateUniqueRoomId");
function createRoomCode(random = Math.random) {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
__name(createRoomCode, "createRoomCode");
function enterExistingLunaNegraRoom(store, room, lunaPlayer, nowMs) {
  const existing = room.players.find((candidate) => candidate.id === lunaPlayer.id);
  if (existing) {
    existing.name = normalizePlayerName(lunaPlayer.name);
    existing.avatarUrl = normalizeAvatarUrl(lunaPlayer.avatarUrl);
    if (lunaPlayer.npub) existing.npub = normalizeNpub(lunaPlayer.npub);
    existing.updatedAtServerMs = nowMs;
    if (room.status === "lobby") existing.status = existing.ready ? "ready" : "joined";
    room.updatedAtServerMs = nowMs;
    return persistRoom(store, room).then(() => room);
  }
  if (room.status !== "lobby") throw new OnlineRoomError("Room already started.", 409);
  room.players.push(createPlayer(lunaPlayer.id, lunaPlayer.name, nowMs, lunaPlayer.avatarUrl, lunaPlayer.npub));
  room.updatedAtServerMs = nowMs;
  return persistRoom(store, room).then(() => room);
}
__name(enterExistingLunaNegraRoom, "enterExistingLunaNegraRoom");
var MemoryRoomStore = class {
  static {
    __name(this, "MemoryRoomStore");
  }
  rooms = /* @__PURE__ */ new Map();
  publicIds = [];
  async getRoom(id) {
    return cloneRoom(this.rooms.get(normalizeRoomId(id)) ?? null);
  }
  async saveRoom(room) {
    const normalized = cloneRoom(room);
    if (!normalized) return;
    const expectedVersion = normalized.version ?? 0;
    const currentVersion = this.rooms.get(normalized.id)?.version ?? 0;
    if (currentVersion !== expectedVersion) throw new RoomVersionConflictError();
    normalized.version = expectedVersion + 1;
    room.version = expectedVersion + 1;
    this.rooms.set(normalized.id, normalized);
    if (normalized.visibility === "public" && !this.publicIds.includes(normalized.id)) {
      this.publicIds = [normalized.id, ...this.publicIds];
    } else if (normalized.visibility !== "public") {
      this.publicIds = this.publicIds.filter((roomId) => roomId !== normalized.id);
    }
  }
  async deleteRoom(id) {
    const normalized = normalizeRoomId(id);
    this.rooms.delete(normalized);
    this.publicIds = this.publicIds.filter((roomId) => roomId !== normalized);
  }
  async listPublicRoomIds() {
    return [...this.publicIds];
  }
  async savePublicRoomIds(ids) {
    this.publicIds = [...new Set(ids.map(normalizeRoomId))];
  }
};
async function persistRoom(store, room) {
  await store.saveRoom(room, ROOM_TTL_SECONDS);
  const publicIds = await store.listPublicRoomIds();
  const nextPublicIds = room.visibility === "public" ? [room.id, ...publicIds.filter((id) => id !== room.id)] : publicIds.filter((id) => id !== room.id);
  await store.savePublicRoomIds(nextPublicIds, ROOM_TTL_SECONDS);
}
__name(persistRoom, "persistRoom");
async function requireRoom(store, roomId) {
  const room = await store.getRoom(normalizeRoomId(roomId));
  if (!room) throw new OnlineRoomError("Room not found.", 404);
  return normalizeRoomShape(room);
}
__name(requireRoom, "requireRoom");
function requirePlayer(room, playerId) {
  const player = room.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new OnlineRoomError("Player is not in this room.", 403);
  return player;
}
__name(requirePlayer, "requirePlayer");
function requireHostAuthority(room, authorityPlayerId) {
  const authority = requirePlayer(room, authorityPlayerId);
  if (authority.id !== room.hostPlayerId) {
    throw new OnlineRoomError("Only the host can authoritatively update the room.", 403);
  }
  return authority;
}
__name(requireHostAuthority, "requireHostAuthority");
function requireSelfOrHostAuthority(room, authorityPlayerId, subjectPlayerId) {
  const authority = requirePlayer(room, authorityPlayerId);
  if (authority.id !== room.hostPlayerId && authority.id !== subjectPlayerId) {
    throw new OnlineRoomError("Not authorized to update this player.", 403);
  }
  return authority;
}
__name(requireSelfOrHostAuthority, "requireSelfOrHostAuthority");
function requestMatchesRoomSeed(room, seed) {
  return seed !== void 0 && normalizeNonNegativeInteger(seed) === room.seed;
}
__name(requestMatchesRoomSeed, "requestMatchesRoomSeed");
function createPlayer(id, name, nowMs, avatarUrl, npub) {
  const normalizedId = normalizePlayerId(id);
  const normalizedName = normalizePlayerName(name);
  return {
    id: normalizedId,
    npub: normalizeNpub(npub),
    name: normalizedName,
    avatarUrl: normalizeAvatarUrl(avatarUrl),
    // Todo el que entra a una sala arranca listo; puede des-marcarse a mano.
    ready: true,
    status: "ready",
    lines: 0,
    pieces: 0,
    elapsedFrames: 0,
    sentGarbage: 0,
    receivedGarbage: 0,
    pendingGarbage: 0,
    alive: true,
    updatedAtServerMs: nowMs,
    finishedAtServerMs: null,
    eliminatedAtFrame: null,
    eliminatedAtServerMs: null,
    game: null,
    targetingMode: "random",
    manualTargetPlayerId: null,
    currentTargetPlayerId: null,
    recentAttackers: [],
    koCount: 0,
    receivedGarbageThisRound: 0,
    dangerLevel: 0
  };
}
__name(createPlayer, "createPlayer");
function roomSummary(room) {
  const host = room.players.find((player) => player.id === room.hostPlayerId);
  return {
    id: room.id,
    hostName: host?.name ?? "Host",
    hostAvatarUrl: host?.avatarUrl ?? null,
    playerCount: room.players.length,
    mode: room.mode,
    matchType: room.matchType,
    region: room.region,
    customPreset: room.matchType === "custom" ? room.ruleset.rulesetId : null,
    ruleset: room.ruleset,
    status: room.status,
    createdAtServerMs: room.createdAtServerMs
  };
}
__name(roomSummary, "roomSummary");
function applyStalePlayers(room, nowMs) {
  return {
    ...room,
    players: room.players.map((player) => {
      if (isTerminalPlayer(player)) return { ...player };
      if (nowMs - player.updatedAtServerMs <= PLAYER_STALE_MS) return { ...player };
      return { ...player, status: "disconnected" };
    }),
    peerSignals: room.peerSignals ?? [],
    attacks: room.attacks ?? []
  };
}
__name(applyStalePlayers, "applyStalePlayers");
function normalizePeerSignalType(value) {
  if (value === "offer" || value === "answer" || value === "ice") return value;
  throw new OnlineRoomError("Invalid peer signal type.");
}
__name(normalizePeerSignalType, "normalizePeerSignalType");
function finishRoomIfOnlyOneAlive(room, nowMs) {
  if (room.status !== "playing" && room.status !== "countdown") return;
  if (room.players.length < 2) return;
  const alive = room.players.filter((player) => player.alive && player.status !== "eliminated");
  if (alive.length === 1) {
    const winner = alive[0];
    winner.status = "winner";
    winner.alive = true;
    winner.finishedAtServerMs = nowMs;
    winner.updatedAtServerMs = nowMs;
    room.winnerPlayerId = winner.id;
    room.status = "finished";
    sealMatchResult(room, nowMs);
    return;
  }
  if (alive.length === 0) {
    const best = rankPlayers(room.players)[0] ?? null;
    room.winnerPlayerId = best?.id ?? null;
    room.status = "finished";
    sealMatchResult(room, nowMs);
  }
}
__name(finishRoomIfOnlyOneAlive, "finishRoomIfOnlyOneAlive");
function applyHostFailover(room, nowMs, staleMs = HOST_STALE_MS) {
  if (room.status !== "playing" && room.status !== "countdown") return false;
  if (nowMs - room.updatedAtServerMs <= staleMs) return false;
  let changed = false;
  const host = room.players.find((player) => player.id === room.hostPlayerId);
  if (host && !isTerminalPlayer(host)) {
    host.status = "eliminated";
    host.alive = false;
    host.ready = true;
    host.finishedAtServerMs = nowMs;
    host.eliminatedAtServerMs = nowMs;
    host.eliminatedAtFrame = host.eliminatedAtFrame ?? normalizeNonNegativeInteger(host.elapsedFrames);
    host.updatedAtServerMs = nowMs;
    changed = true;
  }
  const successor = room.players.find(
    (player) => player.id !== room.hostPlayerId && player.alive && !isTerminalPlayer(player)
  );
  if (successor) {
    room.hostPlayerId = successor.id;
    changed = true;
  }
  finishRoomIfOnlyOneAlive(room, nowMs);
  const finishedByOneAlive = room.status === "finished";
  if (finishedByOneAlive) {
    changed = true;
  } else {
    const aliveCount = room.players.filter((player) => player.alive && !isTerminalPlayer(player)).length;
    if (aliveCount === 0) {
      room.status = "finished";
      room.winnerPlayerId = null;
      sealMatchResult(room, nowMs);
      changed = true;
    }
  }
  if (changed) room.updatedAtServerMs = nowMs;
  return changed;
}
__name(applyHostFailover, "applyHostFailover");
function finishSprintRace(room, winner, nowMs) {
  room.status = "finished";
  room.winnerPlayerId = winner.id;
  sealMatchResult(room, nowMs);
  winner.status = "won";
  winner.alive = true;
  winner.ready = true;
  winner.finishedAtServerMs = nowMs;
  winner.updatedAtServerMs = nowMs;
  for (const player of room.players) {
    if (player.id === winner.id || isTerminalPlayer(player) || !player.alive) continue;
    player.status = "lost";
    player.alive = false;
    player.ready = true;
    player.finishedAtServerMs = nowMs;
    player.updatedAtServerMs = nowMs;
  }
}
__name(finishSprintRace, "finishSprintRace");
function sealMatchResult(room, nowMs) {
  if (!room.matchResultId) room.matchResultId = `${room.id}:${room.seed}:${nowMs}`;
}
__name(sealMatchResult, "sealMatchResult");
function prepareRoundCountdown(room, nowMs, reseed) {
  room.status = "countdown";
  room.startsAtServerMs = nowMs + ROOM_START_DELAY_MS;
  room.winnerPlayerId = null;
  if (reseed) room.seed = randomSeed();
  room.attacks = [];
  room.players.forEach((player) => {
    const plays = isRoundReady(player, nowMs);
    player.lines = 0;
    player.pieces = 0;
    player.elapsedFrames = 0;
    player.sentGarbage = 0;
    player.receivedGarbage = 0;
    player.pendingGarbage = 0;
    player.finishedAtServerMs = null;
    player.eliminatedAtFrame = null;
    player.eliminatedAtServerMs = null;
    player.game = null;
    player.currentTargetPlayerId = null;
    player.recentAttackers = [];
    player.receivedGarbageThisRound = 0;
    player.dangerLevel = 0;
    player.updatedAtServerMs = nowMs;
    if (plays) {
      player.ready = true;
      player.status = "ready";
      player.alive = true;
    } else {
      player.ready = false;
      player.status = "joined";
      player.alive = false;
    }
  });
}
__name(prepareRoundCountdown, "prepareRoundCountdown");
function isTerminalPlayer(player) {
  return player.status === "winner" || player.status === "eliminated" || player.status === "won" || player.status === "lost" || player.finishedAtServerMs !== null;
}
__name(isTerminalPlayer, "isTerminalPlayer");
function isPlayerStale(player, nowMs) {
  return nowMs - player.updatedAtServerMs > PLAYER_STALE_MS;
}
__name(isPlayerStale, "isPlayerStale");
function isRoundReady(player, nowMs) {
  return player.ready && !isPlayerStale(player, nowMs);
}
__name(isRoundReady, "isRoundReady");
function normalizeAttackId(value) {
  const normalized = value.trim().slice(0, 120);
  if (normalized.length < 4) throw new OnlineRoomError("Invalid attack id.");
  return normalized;
}
__name(normalizeAttackId, "normalizeAttackId");
function resultRank(status) {
  if (status === "winner") return 0;
  if (status === "won") return 0;
  if (status === "eliminated") return 1;
  if (status === "lost") return 1;
  return 2;
}
__name(resultRank, "resultRank");
function normalizeVisibility(value) {
  return value === "public" ? "public" : "private";
}
__name(normalizeVisibility, "normalizeVisibility");
function normalizeRegion(value) {
  if (typeof value !== "string") return DEFAULT_ONLINE_REGION;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
  return normalized || DEFAULT_ONLINE_REGION;
}
__name(normalizeRegion, "normalizeRegion");
function normalizeRoomMode(value, strict = false) {
  if (value === void 0 || value === null || value === "custom") return "custom";
  if (!strict) return "custom";
  throw new OnlineRoomError("Only custom online rooms are supported.");
}
__name(normalizeRoomMode, "normalizeRoomMode");
function normalizeMatchType(value, mode, strict = false) {
  void mode;
  if (value === void 0 || value === null || value === "custom") return "custom";
  if (value === "battle") return "battle";
  if (!strict) return "custom";
  throw new OnlineRoomError("Only custom online rooms are supported.");
}
__name(normalizeMatchType, "normalizeMatchType");
function normalizeRuleset(value, matchType, strict = false) {
  const fallback = defaultRuleset(matchType);
  if (value === void 0 || value === null) return fallback;
  if (!isObject(value)) {
    if (strict) throw new OnlineRoomError("Invalid ruleset.");
    return fallback;
  }
  const rulesetId = normalizeRulesetId(value.rulesetId, fallback.rulesetId, strict);
  const rulesetVersion = normalizeRulesetVersion(value.rulesetVersion, fallback.rulesetVersion, strict);
  const objective = normalizeObjective(value.objective, fallback.objective, strict);
  const attackTable = normalizeAttackTable(value.attackTable, fallback.attackTable, strict);
  const targeting = normalizeTargetingMode(value.targeting, strict, fallback.targeting);
  return { rulesetId, rulesetVersion, objective, attackTable, targeting };
}
__name(normalizeRuleset, "normalizeRuleset");
function defaultRuleset(matchType) {
  return {
    // Tabla moderna por defecto: combos, B2B y spins suman líneas de ataque.
    rulesetId: matchType === "battle" ? "battle-last-standing-modern" : "custom-survival-modern",
    rulesetVersion: ONLINE_RULESET_VERSION,
    objective: { type: "lastStanding" },
    attackTable: "modern",
    targeting: "random"
  };
}
__name(defaultRuleset, "defaultRuleset");
function normalizeRulesetId(value, fallback, strict) {
  if (typeof value === "string") {
    const normalized = value.trim().slice(0, 64);
    if (/^[a-z0-9][a-z0-9-]*$/i.test(normalized)) return normalized;
  }
  if (strict) throw new OnlineRoomError("Invalid ruleset id.");
  return fallback;
}
__name(normalizeRulesetId, "normalizeRulesetId");
function normalizeRulesetVersion(value, fallback, strict) {
  const version = Number(value);
  if (Number.isInteger(version) && version >= 1 && version <= ONLINE_RULESET_VERSION) return version;
  if (strict) throw new OnlineRoomError("Invalid ruleset version.");
  return fallback;
}
__name(normalizeRulesetVersion, "normalizeRulesetVersion");
function normalizeObjective(value, fallback, strict) {
  if (isObject(value)) {
    if (value.type === "lastStanding") return { type: "lastStanding" };
    if (value.type === "sprint") {
      return { type: "sprint", targetLines: normalizeObjectiveInteger(value.targetLines, 1, 200, fallback.type === "sprint" ? fallback.targetLines : 40, strict) };
    }
    if (value.type === "survivalScore") {
      const duration = value.durationSeconds === null ? null : normalizeObjectiveInteger(value.durationSeconds, 10, 3600, fallback.type === "survivalScore" ? fallback.durationSeconds ?? 120 : 120, strict);
      return { type: "survivalScore", durationSeconds: duration };
    }
  }
  if (strict) throw new OnlineRoomError("Invalid objective.");
  return fallback;
}
__name(normalizeObjective, "normalizeObjective");
function normalizeObjectiveInteger(value, min, max, fallback, strict) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= min && numeric <= max) return numeric;
  if (strict) throw new OnlineRoomError("Invalid objective value.");
  return fallback;
}
__name(normalizeObjectiveInteger, "normalizeObjectiveInteger");
function normalizeAttackTable(value, fallback, strict) {
  if (value === "simple" || value === "modern") return value;
  if (strict) throw new OnlineRoomError("Invalid attack table.");
  return fallback;
}
__name(normalizeAttackTable, "normalizeAttackTable");
function normalizeTargetingMode(value, strict = false, fallback = "random") {
  if (TARGETING_MODES.includes(value)) return value;
  if (strict) throw new OnlineRoomError("Invalid targeting mode.");
  return fallback;
}
__name(normalizeTargetingMode, "normalizeTargetingMode");
function normalizeManualTarget(room, playerId, value) {
  if (value === null || value === void 0 || value === "") return null;
  if (typeof value !== "string") throw new OnlineRoomError("Invalid manual target.");
  const target = room.players.find((player) => player.id === value);
  if (!target || target.id === playerId || !target.alive || target.status === "eliminated" || target.status === "winner") {
    throw new OnlineRoomError("Invalid manual target.");
  }
  return target.id;
}
__name(normalizeManualTarget, "normalizeManualTarget");
function normalizeRoomRules(value, mode, ruleset) {
  const base = {
    ...cloneRules(BATTLE_RULES),
    attackTable: ruleset.attackTable,
    targetLines: targetLinesForObjective(ruleset.objective)
  };
  if (mode !== "custom" || !isObject(value)) return base;
  return {
    ...base,
    boardWidth: normalizeFiniteRuleNumber(value.boardWidth, base.boardWidth, { min: 4, max: 16, integer: true }),
    visibleRows: normalizeFiniteRuleNumber(value.visibleRows, base.visibleRows, { min: 10, max: 40, integer: true }),
    hiddenRows: normalizeFiniteRuleNumber(value.hiddenRows, base.hiddenRows, { min: 0, max: 10, integer: true }),
    nextPreview: normalizeFiniteRuleNumber(value.nextPreview, base.nextPreview, { min: 0, max: 7, integer: true }),
    targetLines: base.targetLines,
    // La sala custom honra el modelo de gravedad elegido en los ajustes Custom
    // ('guideline' estilo TETR.IO o 'linear' manual); si no llega, cae al de
    // BATTLE_RULES ('guideline').
    gravityCurve: value.gravityCurve === "linear" || value.gravityCurve === "guideline" ? value.gravityCurve : base.gravityCurve,
    gravityCellsPerFrame: normalizeFiniteRuleNumber(value.gravityCellsPerFrame, base.gravityCellsPerFrame, { min: 1e-3, max: 5 }),
    gravityIncreaseCellsPerLevel: normalizeFiniteRuleNumber(value.gravityIncreaseCellsPerLevel, base.gravityIncreaseCellsPerLevel, { min: 0, max: 2 }),
    gravityLevelLines: normalizeFiniteRuleNumber(value.gravityLevelLines, base.gravityLevelLines, { min: 0, max: 60, integer: true }),
    gravityLevelPieces: normalizeFiniteRuleNumber(value.gravityLevelPieces, base.gravityLevelPieces, { min: 0, max: 60, integer: true }),
    gravityStartingLevel: normalizeFiniteRuleNumber(value.gravityStartingLevel, base.gravityStartingLevel, { min: 1, max: 30, integer: true }),
    softDropCellsPerFrame: normalizeFiniteRuleNumber(value.softDropCellsPerFrame, base.softDropCellsPerFrame, { min: 1e-3, max: 20 }),
    lockDelayFrames: normalizeFiniteRuleNumber(value.lockDelayFrames, base.lockDelayFrames, { min: 0, max: 300, integer: true }),
    dasFrames: normalizeFiniteRuleNumber(value.dasFrames, base.dasFrames, { min: 0, max: 60, integer: true }),
    arrFrames: normalizeFiniteRuleNumber(value.arrFrames, base.arrFrames, { min: 0, max: 60, integer: true }),
    garbageDelayFrames: normalizeFiniteRuleNumber(value.garbageDelayFrames, base.garbageDelayFrames, { min: 0, max: 600, integer: true }),
    garbageTravelFrames: normalizeFiniteRuleNumber(value.garbageTravelFrames, base.garbageTravelFrames, { min: 0, max: 600, integer: true }),
    garbageActivationFrames: normalizeFiniteRuleNumber(value.garbageActivationFrames, base.garbageActivationFrames, { min: 0, max: 600, integer: true }),
    garbageCap: normalizeFiniteRuleNumber(value.garbageCap, base.garbageCap, { min: 0, max: 40, integer: true }),
    garbageMessinessPercent: normalizeFiniteRuleNumber(value.garbageMessinessPercent, base.garbageMessinessPercent, { min: 0, max: 100, integer: true }),
    changeOnAttack: normalizeRuleBoolean(value.changeOnAttack, base.changeOnAttack),
    continuousGarbage: normalizeRuleBoolean(value.continuousGarbage, base.continuousGarbage),
    allowHardDrop: normalizeRuleBoolean(value.allowHardDrop, base.allowHardDrop),
    allowHold: normalizeRuleBoolean(value.allowHold, base.allowHold),
    showGhost: normalizeRuleBoolean(value.showGhost, base.showGhost),
    infiniteHold: normalizeRuleBoolean(value.infiniteHold, base.infiniteHold),
    infiniteMovement: normalizeRuleBoolean(value.infiniteMovement, base.infiniteMovement),
    lockResetLimit: normalizeFiniteRuleNumber(value.lockResetLimit, base.lockResetLimit, { min: 0, max: 99, integer: true })
  };
}
__name(normalizeRoomRules, "normalizeRoomRules");
function targetLinesForObjective(objective) {
  if (objective.type === "sprint") return objective.targetLines;
  return null;
}
__name(targetLinesForObjective, "targetLinesForObjective");
function normalizeRoomId(value) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, ROOM_ID_MAX_LENGTH);
}
__name(normalizeRoomId, "normalizeRoomId");
function normalizeRoomIdStrict(value) {
  const normalized = normalizeRoomId(value);
  if (normalized.length < ROOM_ID_MIN_LENGTH) throw new OnlineRoomError("Invalid room id.");
  return normalized;
}
__name(normalizeRoomIdStrict, "normalizeRoomIdStrict");
function normalizePlayerId(value) {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 80) throw new OnlineRoomError("Invalid player id.");
  return normalized;
}
__name(normalizePlayerId, "normalizePlayerId");
function normalizePlayerName(value) {
  const normalized = value.trim().slice(0, 18);
  return normalized.length > 0 ? normalized : "Player";
}
__name(normalizePlayerName, "normalizePlayerName");
function normalizeAvatarUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
__name(normalizeAvatarUrl, "normalizeAvatarUrl");
function normalizeNpub(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}
__name(normalizeNpub, "normalizeNpub");
var ROOM_BET_STATUSES = [
  "pending_deposits",
  "funded",
  "settled",
  "cancelled",
  "expired",
  "refunded"
];
function normalizeBetStatus(value) {
  return ROOM_BET_STATUSES.includes(value) ? value : "pending_deposits";
}
__name(normalizeBetStatus, "normalizeBetStatus");
function isTerminalRoomBetStatus(status) {
  return status === "settled" || status === "cancelled" || status === "expired" || status === "refunded";
}
__name(isTerminalRoomBetStatus, "isTerminalRoomBetStatus");
function normalizeBetDepositStatus(value) {
  if (value === "paid" || value === "refunded" || value === "failed") return value;
  return "pending";
}
__name(normalizeBetDepositStatus, "normalizeBetDepositStatus");
function normalizeNullableString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
__name(normalizeNullableString, "normalizeNullableString");
function normalizeNullableSats(value) {
  if (value === null || value === void 0) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}
__name(normalizeNullableSats, "normalizeNullableSats");
function normalizeBet(value) {
  if (!isObject(value)) return null;
  const betId = normalizeNullableString(value.betId);
  if (!betId) return null;
  const participants = Array.isArray(value.participants) ? value.participants.filter((entry) => isObject(entry) && typeof entry.npub === "string").map((entry) => ({
    npub: String(entry.npub),
    playerId: normalizeNullableString(entry.playerId),
    depositStatus: normalizeBetDepositStatus(entry.depositStatus),
    bolt11: normalizeNullableString(entry.bolt11),
    lnurl: normalizeNullableString(entry.lnurl),
    payUrl: normalizeNullableString(entry.payUrl),
    depositError: normalizeNullableString(entry.depositError),
    payoutSats: normalizeNullableSats(entry.payoutSats)
  })) : [];
  const winnerNpubs = Array.isArray(value.winnerNpubs) ? value.winnerNpubs.filter((item) => typeof item === "string") : null;
  return {
    betId,
    status: normalizeBetStatus(value.status),
    stakeSats: normalizeNonNegativeInteger(Number(value.stakeSats ?? 0)),
    potSats: normalizeNonNegativeInteger(Number(value.potSats ?? 0)),
    potTargetSats: normalizeNonNegativeInteger(Number(value.potTargetSats ?? 0)),
    feeSats: normalizeNonNegativeInteger(Number(value.feeSats ?? 0)),
    feePct: Number.isFinite(Number(value.feePct)) ? Number(value.feePct) : 0,
    netPayoutSats: normalizeNonNegativeInteger(Number(value.netPayoutSats ?? 0)),
    depositDeadline: normalizeNullableString(value.depositDeadline),
    depositsReceived: normalizeNonNegativeInteger(Number(value.depositsReceived ?? 0)),
    depositsTotal: normalizeNonNegativeInteger(Number(value.depositsTotal ?? participants.length)),
    participants,
    winnerNpubs,
    resultReported: value.resultReported === true,
    settlementError: normalizeNullableString(value.settlementError),
    createdByPlayerId: normalizeNullableString(value.createdByPlayerId) ?? "",
    createdAtServerMs: normalizeNonNegativeInteger(Number(value.createdAtServerMs ?? 0)),
    updatedAtServerMs: normalizeNonNegativeInteger(Number(value.updatedAtServerMs ?? 0))
  };
}
__name(normalizeBet, "normalizeBet");
async function setRoomBetOnce(store, roomId, bet, nowMs = Date.now()) {
  const room = await requireRoom(store, roomId);
  room.bet = bet ? normalizeBet(bet) : null;
  room.updatedAtServerMs = nowMs;
  await persistRoom(store, room);
  return room;
}
__name(setRoomBetOnce, "setRoomBetOnce");
function lunaNegraPlayerFromInvite(invite) {
  const pubkey = normalizePlayerId(invite.pubkey);
  const npub = typeof invite.npub === "string" ? invite.npub.trim() : "";
  return {
    id: pubkey,
    npub,
    pubkey,
    name: displayNameFromInvite(invite.displayName, npub),
    displayName: invite.displayName,
    avatarUrl: normalizeAvatarUrl(invite.avatarUrl),
    host: invite.host,
    hostPubkey: invite.hostPubkey,
    expiresAt: invite.expiresAt
  };
}
__name(lunaNegraPlayerFromInvite, "lunaNegraPlayerFromInvite");
function displayNameFromInvite(displayName, npub) {
  const normalized = normalizePlayerName(displayName ?? "");
  if (normalized !== "Player") return normalized;
  if (npub.length > 12) return `${npub.slice(0, 8)}...${npub.slice(-4)}`;
  return npub || "Player";
}
__name(displayNameFromInvite, "displayNameFromInvite");
function normalizeNonNegativeInteger(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
__name(normalizeNonNegativeInteger, "normalizeNonNegativeInteger");
function normalizeFiniteRuleNumber(value, fallback, options) {
  const numeric = typeof value === "string" ? Number(value.trim().replace(",", ".")) : Number(value);
  const finite = Number.isFinite(numeric) ? numeric : fallback;
  const rounded = options.integer ? Math.round(finite) : finite;
  return Math.min(options.max, Math.max(options.min, rounded));
}
__name(normalizeFiniteRuleNumber, "normalizeFiniteRuleNumber");
function normalizeRuleBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
__name(normalizeRuleBoolean, "normalizeRuleBoolean");
function cloneRules(rules) {
  return { ...rules };
}
__name(cloneRules, "cloneRules");
function prependUnique(values, value, limit) {
  return [value, ...values.filter((candidate) => candidate !== value)].slice(0, limit);
}
__name(prependUnique, "prependUnique");
function isObject(value) {
  return typeof value === "object" && value !== null;
}
__name(isObject, "isObject");
function randomSeed() {
  return Math.floor(Math.random() * 4294967295);
}
__name(randomSeed, "randomSeed");
function cloneRoom(room) {
  return room ? JSON.parse(JSON.stringify(room)) : null;
}
__name(cloneRoom, "cloneRoom");
function normalizeRoomShape(room) {
  const mode = normalizeRoomMode(room.mode);
  const matchType = normalizeMatchType(room.matchType, mode);
  const ruleset = normalizeRuleset(room.ruleset, matchType);
  return {
    ...room,
    mode,
    matchType,
    region: normalizeRegion(room.region),
    ruleset,
    rules: normalizeRoomRules(room.rules, mode, ruleset),
    winnerPlayerId: room.winnerPlayerId ?? null,
    matchResultId: room.matchResultId ?? null,
    bet: normalizeBet(room.bet),
    lunaGameId: normalizeNullableString(room.lunaGameId),
    peerSignals: room.peerSignals ?? [],
    attacks: (room.attacks ?? []).map((attack) => ({
      ...attack,
      authorityPlayerId: attack.authorityPlayerId ?? room.hostPlayerId
    })),
    players: room.players.map((player) => ({
      ...player,
      npub: normalizeNpub(player.npub),
      avatarUrl: normalizeAvatarUrl(player.avatarUrl),
      sentGarbage: player.sentGarbage ?? 0,
      receivedGarbage: player.receivedGarbage ?? 0,
      pendingGarbage: player.pendingGarbage ?? 0,
      alive: player.alive ?? !isTerminalPlayer(player),
      eliminatedAtFrame: player.eliminatedAtFrame ?? null,
      eliminatedAtServerMs: player.eliminatedAtServerMs ?? null,
      game: player.game ?? null,
      targetingMode: normalizeTargetingMode(player.targetingMode, false, ruleset.targeting),
      manualTargetPlayerId: player.manualTargetPlayerId ?? null,
      currentTargetPlayerId: player.currentTargetPlayerId ?? null,
      recentAttackers: Array.isArray(player.recentAttackers) ? player.recentAttackers.filter((id) => typeof id === "string").slice(0, 8) : [],
      koCount: normalizeNonNegativeInteger(player.koCount ?? 0),
      receivedGarbageThisRound: normalizeNonNegativeInteger(player.receivedGarbageThisRound ?? 0),
      dangerLevel: normalizeNonNegativeInteger(player.dangerLevel ?? 0)
    }))
  };
}
__name(normalizeRoomShape, "normalizeRoomShape");

// src/online/roomDispatch.ts
async function dispatchRoomAction(store, partyId, action, payload, nowMs = Date.now()) {
  const scoped = /* @__PURE__ */ __name(() => ({ ...asObject(payload), roomId: partyId }), "scoped");
  const done = /* @__PURE__ */ __name((room, hostMigratedTo) => ({
    room,
    serverNowMs: nowMs,
    ...hostMigratedTo !== void 0 ? { hostMigratedTo } : {}
  }), "done");
  switch (action) {
    case "create":
      return done(await createRoom(store, scoped(), nowMs));
    case "join":
      return done(await joinRoom(store, scoped(), nowMs));
    case "leave": {
      const { room, hostMigratedTo } = await leaveRoom(store, scoped(), nowMs);
      return done(room, hostMigratedTo);
    }
    case "kick":
      return done(await kickPlayer(store, scoped(), nowMs));
    case "ready":
      return done(await setPlayerReady(store, scoped(), nowMs));
    case "start":
      return done(await startRoom(store, scoped(), nowMs));
    case "restart":
      return done(await restartRoom(store, scoped(), nowMs));
    case "reopen":
      return done(await reopenRoom(store, scoped(), nowMs));
    case "settings":
      return done(await updateRoomSettings(store, scoped(), nowMs));
    case "targeting":
      return done(await setPlayerTargeting(store, scoped(), nowMs));
    case "progress":
      return done(await updateProgress(store, scoped(), nowMs));
    case "result":
      return done(await submitResult(store, scoped(), nowMs));
    case "attack":
      return done(await addAttack(store, scoped(), nowMs));
    case "eliminate":
      return done(await eliminatePlayer(store, scoped(), nowMs));
    case "failover":
      return done(await requestHostFailover(store, scoped(), nowMs));
    case "signal":
      return done(await addPeerSignal(store, scoped(), nowMs));
    case "state": {
      const presencePlayerId = readPlayerId(payload);
      return done(await getRoomState(store, partyId, nowMs, presencePlayerId));
    }
    default:
      throw new OnlineRoomError(`Unknown room action: ${action}`, 400);
  }
}
__name(dispatchRoomAction, "dispatchRoomAction");
function asObject(payload) {
  return payload && typeof payload === "object" ? payload : {};
}
__name(asObject, "asObject");
var LOBBY_PARTY_ID = "index";
function lobbyEntryForRoom(room) {
  if (!room || room.visibility !== "public") return null;
  if (room.status !== "lobby" && room.status !== "countdown") return null;
  return roomSummary(room);
}
__name(lobbyEntryForRoom, "lobbyEntryForRoom");
function lobbyUpdateForRoom(roomId, room) {
  const summary = lobbyEntryForRoom(room);
  return summary ? { op: "upsert", summary } : { op: "remove", roomId };
}
__name(lobbyUpdateForRoom, "lobbyUpdateForRoom");
function lobbyUpdateKey(update) {
  switch (update.op) {
    case "upsert":
      return `upsert:${JSON.stringify(update.summary)}`;
    case "remove":
      return `remove:${update.roomId}`;
    case "arm-removal":
      return `arm:${update.roomId}:${update.graceMs}`;
    case "cancel-removal":
      return `cancel:${update.roomId}`;
  }
}
__name(lobbyUpdateKey, "lobbyUpdateKey");
function readPlayerId(payload) {
  const value = asObject(payload).playerId;
  return typeof value === "string" ? value : void 0;
}
__name(readPlayerId, "readPlayerId");

// party/room.ts
var ROOM_STORAGE_KEY = "room";
var ROOM_ID_STORAGE_KEY = "roomId";
var ABANDON_AT_STORAGE_KEY = "abandonAt";
var DEFAULT_ABANDON_GRACE_MS = 15e3;
var RoomServer = class extends Server {
  static {
    __name(this, "RoomServer");
  }
  store = new MemoryRoomStore();
  /** Última clave enviada al lobby; dedup para no reavisar lo mismo (ej. cada ataque en 'playing'). */
  lastLobbyKey = null;
  /**
   * Rehidrata la sala desde el storage durable al (re)arrancar la instancia. El
   * DO hiberna sin conexiones y pierde la RAM; sin esto, una reconexión tras un
   * blip total caería en una sala vacía. Reseteamos la versión porque el CAS del
   * MemoryRoomStore es irrelevante acá (un solo escritor en serie).
   */
  async onStart() {
    const stored = await this.ctx.storage.get(ROOM_STORAGE_KEY);
    if (!stored) return;
    stored.version = 0;
    await this.store.saveRoom(stored);
  }
  async onConnect(connection) {
    await this.ctx.storage.delete(ABANDON_AT_STORAGE_KEY);
    await this.ctx.storage.put(ROOM_ID_STORAGE_KEY, this.name);
    await this.postToLobby({ op: "cancel-removal", roomId: this.name });
    const room = await this.store.getRoom(this.name);
    if (room) {
      const message = { type: "room", room, serverNowMs: Date.now() };
      connection.send(JSON.stringify(message));
    }
    await this.rescheduleAlarm(this.name);
  }
  async onClose(connection) {
    const remaining = [...this.getConnections()].filter((c) => c.id !== connection.id).length;
    if (remaining > 0) return;
    const grace = this.abandonGraceMs();
    await this.ctx.storage.put(ROOM_ID_STORAGE_KEY, this.name);
    await this.ctx.storage.put(ABANDON_AT_STORAGE_KEY, Date.now() + grace);
    await this.postToLobby({ op: "arm-removal", roomId: this.name, graceMs: grace });
    await this.rescheduleAlarm(this.name);
  }
  /**
   * Alarm unificado. Según la fecha que venció:
   *  - Sin conexiones y vencida la gracia → la sala está abandonada: se borra su
   *    storage local (el listado lo limpia el LobbyParty por su lado, porque acá
   *    no se puede hablar con otro DO ni leer la identidad de forma fiable).
   *  - Con conexiones → tick autoritativo: aplica las transiciones temporales
   *    (countdown→playing, host failover) vía `getRoomState` y empuja el resultado.
   */
  async onAlarm() {
    const roomId = await this.ctx.storage.get(ROOM_ID_STORAGE_KEY);
    if (!roomId) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if ([...this.getConnections()].length === 0) {
      const abandonAt = await this.ctx.storage.get(ABANDON_AT_STORAGE_KEY);
      if (abandonAt != null && Date.now() >= abandonAt) {
        await this.clearRoomStorage(roomId);
        return;
      }
      await this.rescheduleAlarm(roomId);
      return;
    }
    try {
      const room = await getRoomState(this.store, roomId, Date.now());
      await this.persistAndBroadcastRoom(room, Date.now());
    } catch (error) {
      if (error instanceof OnlineRoomError && error.status === 404) {
        await this.clearRoomStorage(roomId);
        return;
      }
      throw error;
    }
    await this.rescheduleAlarm(roomId);
  }
  // ⚠️ partyserver invierte el orden respecto a PartyKit: (connection, message).
  async onMessage(sender, raw) {
    if (typeof raw !== "string") return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      const result = await dispatchRoomAction(this.store, this.name, message.action, message.payload);
      this.reply(sender, { type: "reply", reqId: message.reqId, ok: true, ...result });
      if (result.room) {
        await this.persistAndBroadcastRoom(result.room, result.serverNowMs);
      } else {
        await this.ctx.storage.delete(ROOM_STORAGE_KEY);
        await this.ctx.storage.delete(ROOM_ID_STORAGE_KEY);
      }
      await this.syncLobby(result.room);
      await this.rescheduleAlarm(this.name);
    } catch (error) {
      const status = error instanceof OnlineRoomError ? error.status : 500;
      const text = error instanceof Error ? error.message : "Unexpected server error.";
      this.reply(sender, { type: "reply", reqId: message.reqId, ok: false, status, error: text, serverNowMs: Date.now() });
    }
  }
  reply(connection, message) {
    connection.send(JSON.stringify(message));
  }
  abandonGraceMs() {
    return Number(this.env.PARTY_ABANDON_GRACE_MS) || DEFAULT_ABANDON_GRACE_MS;
  }
  /** Empuja el room a todas las conexiones y lo persiste (sobrevive hibernación). */
  async persistAndBroadcastRoom(room, serverNowMs) {
    const broadcast = { type: "room", room, serverNowMs };
    this.broadcast(JSON.stringify(broadcast));
    await this.ctx.storage.put(ROOM_STORAGE_KEY, room);
    await this.ctx.storage.put(ROOM_ID_STORAGE_KEY, room.id);
  }
  /** Borra todo rastro local de la sala (abandono / 404). El alarm queda sin fecha. */
  async clearRoomStorage(roomId) {
    await this.store.deleteRoom(roomId);
    await this.ctx.storage.delete(ROOM_STORAGE_KEY);
    await this.ctx.storage.delete(ROOM_ID_STORAGE_KEY);
    await this.ctx.storage.delete(ABANDON_AT_STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
  }
  /**
   * Fecha tope más próxima del alarm unificado, o null si no hay nada que esperar:
   *  - abandono: el `abandonAt` guardado (sala sin conexiones en gracia);
   *  - countdown→playing: `startsAtServerMs`;
   *  - host failover: `updatedAtServerMs + HOST_STALE_MS` (+1 para superar el `<=`
   *    de applyHostFailover). Mientras el host escribe, esta fecha se corre sola y
   *    el tick nunca dispara failover; si se queda mudo, vence y el tick lo migra.
   */
  async nextDeadlineMs(roomId) {
    const deadlines = [];
    const abandonAt = await this.ctx.storage.get(ABANDON_AT_STORAGE_KEY);
    if (abandonAt != null) deadlines.push(abandonAt);
    const room = await this.store.getRoom(roomId);
    if (room) {
      if (room.status === "countdown" && room.startsAtServerMs != null) deadlines.push(room.startsAtServerMs);
      if (room.status === "countdown" || room.status === "playing") deadlines.push(room.updatedAtServerMs + HOST_STALE_MS + 1);
    }
    return deadlines.length ? Math.min(...deadlines) : null;
  }
  /** Fija el alarm único a la próxima fecha tope (o lo borra si no hay ninguna). */
  async rescheduleAlarm(roomId) {
    const next = await this.nextDeadlineMs(roomId);
    if (next == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1));
  }
  /** Avisa al LobbyParty del estado listable de esta sala (con dedup). */
  async syncLobby(room) {
    const update = lobbyUpdateForRoom(this.name, room);
    const key = lobbyUpdateKey(update);
    if (key === this.lastLobbyKey) return;
    this.lastLobbyKey = key;
    await this.postToLobby(update);
  }
  /** POST best-effort al LobbyParty (otro Durable Object). Sin dedup: lo hace syncLobby. */
  async postToLobby(update) {
    try {
      const lobby = await getServerByName(this.env.Lobby, LOBBY_PARTY_ID);
      await lobby.fetch(new Request("https://lobby/notify", { method: "POST", body: JSON.stringify(update) }));
    } catch {
      this.lastLobbyKey = null;
    }
  }
};

// party/lobby.ts
var ROOMS_STORAGE_KEY = "rooms";
var PENDING_STORAGE_KEY = "pending";
var LobbyServer = class extends Server {
  static {
    __name(this, "LobbyServer");
  }
  rooms = /* @__PURE__ */ new Map();
  /** roomId → instante (ms) en que debe removerse del listado si nadie reconecta. */
  pendingRemoval = /* @__PURE__ */ new Map();
  async onStart() {
    const storedRooms = await this.ctx.storage.get(ROOMS_STORAGE_KEY);
    if (storedRooms) for (const [id, summary] of Object.entries(storedRooms)) this.rooms.set(id, summary);
    const storedPending = await this.ctx.storage.get(PENDING_STORAGE_KEY);
    if (storedPending) for (const [id, at] of Object.entries(storedPending)) this.pendingRemoval.set(id, at);
  }
  onConnect(connection) {
    connection.send(this.roomsMessage());
  }
  async onRequest(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    switch (update.op) {
      case "upsert":
        this.rooms.set(update.summary.id, update.summary);
        this.pendingRemoval.delete(update.summary.id);
        await this.persistAndBroadcast();
        break;
      case "remove":
        this.rooms.delete(update.roomId);
        this.pendingRemoval.delete(update.roomId);
        await this.persistAndBroadcast();
        break;
      case "arm-removal":
        this.pendingRemoval.set(update.roomId, Date.now() + update.graceMs);
        await this.persistPending();
        await this.rescheduleSweep();
        break;
      case "cancel-removal":
        if (this.pendingRemoval.delete(update.roomId)) {
          await this.persistPending();
          await this.rescheduleSweep();
        }
        break;
      default:
        return new Response("Bad request", { status: 400 });
    }
    return Response.json({ ok: true, count: this.rooms.size });
  }
  /** Barrido de la gracia: remueve del listado las salas cuya remoción venció. */
  async onAlarm() {
    const now = Date.now();
    let changed = false;
    for (const [roomId, at] of this.pendingRemoval) {
      if (at > now) continue;
      this.pendingRemoval.delete(roomId);
      if (this.rooms.delete(roomId)) changed = true;
    }
    await this.persistPending();
    if (changed) await this.persistAndBroadcast();
    await this.rescheduleSweep();
  }
  /** Programa el alarm para la próxima remoción pendiente (o lo cancela si no hay). */
  async rescheduleSweep() {
    if (this.pendingRemoval.size === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...this.pendingRemoval.values());
    await this.ctx.storage.setAlarm(next);
  }
  async persistAndBroadcast() {
    await this.ctx.storage.put(ROOMS_STORAGE_KEY, Object.fromEntries(this.rooms));
    this.broadcast(this.roomsMessage());
  }
  async persistPending() {
    await this.ctx.storage.put(PENDING_STORAGE_KEY, Object.fromEntries(this.pendingRemoval));
  }
  roomsMessage() {
    const rooms = [...this.rooms.values()].sort((a, b) => b.createdAtServerMs - a.createdAtServerMs);
    const message = { type: "rooms", rooms, serverNowMs: Date.now() };
    return JSON.stringify(message);
  }
};

// party/index.ts
var party_default = {
  async fetch(request, env2) {
    return await routePartykitRequest(request, env2) ?? new Response("Not Found", { status: 404 });
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env2, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env2);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env2, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env2);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-lYkySg/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = party_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env2, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env2, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env2, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env2, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-lYkySg/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env2, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env2, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env2, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env2, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env2, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env2, ctx) => {
      this.env = env2;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  LobbyServer,
  RoomServer,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
