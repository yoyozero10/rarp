import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { Store } from "../storage/store.js";

export function serveDashboard(path: string, res: ServerResponse) {
  if (
    path !== "/ui" &&
    path !== "/ui/" &&
    !/^\/ui\/assets\/[a-zA-Z0-9_.-]+$/.test(path)
  )
    return false;
  try {
    const relative = path.startsWith("/ui/assets/")
      ? path.slice(4)
      : "index.html";
    const content = readFileSync(
      fileURLToPath(new URL("../ui/" + relative, import.meta.url)),
    );
    res.setHeader(
      "content-type",
      relative.endsWith(".js")
        ? "text/javascript"
        : relative.endsWith(".css")
          ? "text/css"
          : "text/html; charset=utf-8",
    );
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end("Dashboard unavailable. Run npm run build.");
  }
  return true;
}

export function observer(store: Store, runtime: () => unknown) {
  const streams = new Set<ServerResponse>();
  return {
    close() {
      for (const res of streams) res.end();
      streams.clear();
    },
    handle(req: IncomingMessage, res: ServerResponse, url: URL) {
      if (req.method !== "GET") return false;
      const reply = (data: unknown) => res.end(JSON.stringify(data));
      if (url.pathname === "/snapshot") {
        reply({ ...store.observation(), runtime: runtime() });
        return true;
      }
      if (url.pathname === "/events") {
        reply(
          store.eventPage(
            Number(url.searchParams.get("after") ?? 0),
            Number(url.searchParams.get("limit") ?? 100),
            url.searchParams.get("taskId") ?? undefined,
          ),
        );
        return true;
      }
      if (url.pathname === "/diff") {
        const id = url.searchParams.get("taskId");
        if (!id) throw new Error("taskId required");
        store.show(id);
        const workspace = store.workspace(id);
        if (!workspace?.commit) {
          reply({
            workspace: workspace ?? null,
            diff: "",
            stat: "",
            message: "Chưa có commit được checkpoint.",
          });
          return true;
        }
        const commit = workspace.commit;
        const diff = (args: string[]) =>
          execFileSync(
            "git",
            [
              "-C",
              workspace.path,
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              ...args,
              workspace.base,
              commit,
              "--",
            ],
            {
              encoding: "utf8",
              windowsHide: true,
              maxBuffer: 2 * 1024 * 1024,
              timeout: 10000,
            },
          );
        reply({
          workspace,
          diff: diff([]),
          stat: diff(["--stat"]),
          message:
            "Diff của commit checkpoint; thay đổi chưa commit không nằm trong bản này.",
        });
        return true;
      }
      if (url.pathname !== "/stream") return false;
      let cursor = Number(
        req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
      );
      store.eventPage(cursor, 1); // Validate before sending streaming headers.
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.flushHeaders();
      streams.add(res);
      const send = () => {
        try {
          const page = store.eventPage(cursor, 100);
          for (const event of page.events) {
            cursor = Number(event["id"]);
            if (
              !res.write(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`)
            ) {
              res.end();
              break;
            }
          }
          if (!page.events.length) res.write(": heartbeat\n\n");
        } catch {
          res.end();
        }
      };
      const timer = setInterval(send, 500);
      send();
      res.once("close", () => {
        clearInterval(timer);
        streams.delete(res);
      });
      return true;
    },
  };
}
