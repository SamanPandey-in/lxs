// A scriptable fetch standing in for the browser's: /api/config is answered locally,
// everything else goes to the `api` handler, and every API call is recorded.
export function installFetch({ allowMock = false } = {}) {
  const state = {
    calls: [],
    api: () => json(200, {}),
  };
  globalThis.window = globalThis.window ?? {};
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === "/api/config")
      return json(200, { apiUrl: "http://api.test", projectId: null, allowMock });
    const path = String(url).replace("http://api.test", "");
    const method = init.method ?? "GET";
    state.calls.push({ method, path, body: init.body });
    return state.api(path, method, init);
  };
  return state;
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status });
}

export const networkDown = () => {
  throw new TypeError("fetch failed");
};

/** Never answers, but honours abort the way a real fetch does. */
export const hang = (_path, _method, init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });

export const PROJECTS = { items: [{ id: "real-project", slug: "acme-shop" }] };

/** The API behaving: project discovery works, `over` answers the rest. */
export const healthy =
  (over = () => json(200, { items: [] })) =>
  (path, method, init) =>
    path === "/v1/projects" ? json(200, PROJECTS) : over(path, method, init);
