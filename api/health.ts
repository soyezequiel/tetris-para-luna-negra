export function GET(): Response {
  return Response.json({
    ok: true,
    runtime: 'vercel-function',
    serverNowMs: Date.now(),
  });
}
