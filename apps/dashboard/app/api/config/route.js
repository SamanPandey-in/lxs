// Runtime configuration for the browser.
//
// NEXT_PUBLIC_* is inlined into the bundle at BUILD time, so a production image
// built once and deployed anywhere would carry whatever API URL the build machine
// happened to have. This route is evaluated per request on the server, so the same
// built image picks up its environment wherever it runs.
//
// Keep this response free of secrets: everything here is handed to the browser.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      apiUrl: process.env.LXS_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080",
      // null means "ask the API which project to show" (lib/core.js resolveProject).
      projectId: process.env.LXS_PROJECT_ID || process.env.NEXT_PUBLIC_PROJECT_ID || null,
      // Off unless an operator opts in: lets reads show lib/mock.js during an API outage.
      allowMock: process.env.LXS_ALLOW_MOCK === "1",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
