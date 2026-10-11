export function onRequest({ request, env, params }) {
  if (!/^[a-f0-9-]{36}$/.test(params.slug)) return new Response("文章不存在", { status: 404 });
  const url = new URL(request.url); url.pathname = "/blog/read/";
  return env.ASSETS.fetch(new Request(url, request));
}
