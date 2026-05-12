import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, mergeEvents, setToken, stream } from "./client";
import type { Row, Snapshot, Task, Workspace } from "./client";
import "./style.css";
const names: Record<string, string> = {
  queued: "Chờ chạy",
  running: "Đang làm",
  submitted: "Đã nộp",
  reviewing: "Đang review",
  accepted: "Đã nghiệm thu",
  changes_requested: "Cần sửa",
  failed: "Lỗi",
  blocked: "Bị chặn",
  cancelled: "Đã hủy",
};
const short = (s: string) => s.slice(0, 8);
function Badge({ status }: { status: string }) {
  return <span className={"badge " + status}>{names[status] ?? status}</span>;
}
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [connection, setConnection] = useState("Đang kết nối"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    [events, setEvents] = useState<Row[]>([]),
    [selected, setSelected] = useState(""),
    [view, setView] = useState("board"),
    [tab, setTab] = useState("overview"),
    [theme, setTheme] = useState(
      localStorage.getItem("rarp-theme") ?? "system",
    ),
    [create, setCreate] = useState(false),
    [filter, setFilter] = useState(""),
    [log, setLog] = useState<Row[]>([]),
    [cursor, setCursor] = useState(0),
    [more, setMore] = useState(false),
    [diff, setDiff] = useState<{
      diff: string;
      stat: string;
      message: string;
      workspace: Workspace | null;
    } | null>(null),
    [revision, setRevision] = useState(0);
  const [actor, setActor] = useState(""),
    [note, setNote] = useState(""),
    [scope, setScope] = useState("src"),
    [check, setCheck] = useState('["node","--test"]'),
    [adapter, setAdapter] = useState("codex");
  const refresh = async () => {
    const data = await api<Snapshot>("snapshot");
    setSnapshot((old) =>
      old && old.lastEventId > data.lastEventId ? old : data,
    );
    setEvents((old) => mergeEvents(old, data.recentEvents));
    return data;
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("rarp-theme", theme);
  }, [theme]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let initialized = false;
    const connect = async () => {
      try {
        const data = await refreshRef.current();
        if (controller.signal.aborted) return;
        if (!initialized) {
          cursor = data.lastEventId;
          initialized = true;
        }
        setConnection("Đã kết nối");
        setError("");
        await stream(cursor, controller.signal, (event) => {
          if (event.id <= cursor) return;
          cursor = event.id;
          setEvents((old) => mergeEvents(old, [event]));
          if (!timer)
            timer = setTimeout(() => {
              timer = undefined;
              void refreshRef.current().catch((e) => setError(String(e)));
            }, 200);
        });
      } catch (e) {
        if (!controller.signal.aborted) {
          setConnection("Mất kết nối · thử lại");
          setError(String(e));
        }
      }
      if (!controller.signal.aborted) retry = setTimeout(connect, 2000);
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
      clearTimeout(timer);
    };
  }, [revision]);
  const task = snapshot?.tasks.find((t) => t.id === selected);
  useEffect(() => {
    setDiff(null);
    setLog([]);
    setCursor(0);
    setMore(false);
    if (!selected) return;
    let live = true;
    void api<{ events: Row[]; nextCursor: number; hasMore: boolean }>(
      "events?taskId=" + encodeURIComponent(selected) + "&limit=100",
    )
      .then((p) => {
        if (live) {
          setLog(p.events);
          setCursor(p.nextCursor);
          setMore(p.hasMore);
        }
      })
      .catch((e) => setError(String(e)));
    void api<typeof diff>("diff?taskId=" + encodeURIComponent(selected))
      .then((p) => {
        if (live) setDiff(p);
      })
      .catch((e) => setError(String(e)));
    return () => {
      live = false;
    };
  }, [selected, task?.workspace?.commit, task?.workspace?.integrated]);
  useEffect(() => {
    if (!task && !create) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () => [
      ...(dialog?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      ) ?? []),
    ];
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelected("");
        setCreate(false);
      }
      if (event.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [!!task, create]);
  async function action(label: string, fn: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice(label + "…");
    try {
      await fn();
      await refresh();
      setNotice(label + " thành công");
    } catch (e) {
      setError(String(e));
      setNotice("");
    } finally {
      setPending(false);
    }
  }
  function transition(status: string) {
    if (!task) return;
    void action("Cập nhật task", () =>
      api("transition", {
        taskId: task.id,
        actor,
        expectedStatus: task.status,
        status,
        note,
      }),
    );
  }
  const managers = snapshot?.agents.filter((a) => a.role === "manager") ?? [],
    workers = snapshot?.agents.filter((a) => a.role === "worker") ?? [];
  const visible =
    snapshot?.tasks.filter((t) =>
      (t.title + " " + t.assigned_to + " " + t.id)
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) ?? [];
  const taskEvents = mergeEvents(
    log,
    events.filter((e) => e.task_id === selected),
    1000,
  );
  return (
    <div className="shell">
      <aside inert={!!task || create}>
        <a className="brand" href="/ui/">
          Rarp<span>LOCAL RUNTIME</span>
        </a>
        <nav aria-label="Điều hướng">
          {[
            ["board", "Công việc"],
            ["agents", "Agent"],
            ["timeline", "Dòng sự kiện"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <span className="live-dot" />
          {connection}
          <small>Mỗi dự án · 1 worker đồng thời</small>
          <label>
            Giao diện
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              <option value="system">Theo hệ thống</option>
              <option value="light">Sáng</option>
              <option value="dark">Tối</option>
            </select>
          </label>
        </div>
      </aside>
      <main inert={!!task || create}>
        <header>
          <div>
            <p className="eyebrow">KHÔNG GIAN LÀM VIỆC</p>
            <h1>
              {view === "board"
                ? "Công việc"
                : view === "agents"
                  ? "Đội ngũ agent"
                  : "Dòng sự kiện"}
            </h1>
          </div>
          <div className="toolbar">
            <span className="runtime">
              Runtime · {snapshot?.runtime.state ?? "Chưa kết nối"}
            </span>
            <button onClick={() => setRevision((x) => x + 1)}>
              Kết nối lại
            </button>
            <button
              className="primary"
              disabled={!snapshot}
              onClick={() => setCreate(true)}
            >
              + Tạo task
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="alert">
            <strong>Không thể hoàn tất</strong>
            <p>{error}</p>
            {!snapshot && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setToken(String(new FormData(e.currentTarget).get("token")));
                  setRevision((x) => x + 1);
                }}
              >
                <label>
                  Token từ lệnh rarp ui
                  <input
                    name="token"
                    type="password"
                    required
                    autoComplete="off"
                  />
                </label>
                <button>Kết nối</button>
              </form>
            )}
          </div>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {!snapshot ? (
          <section className="empty">
            Mở runtime bằng CLI, sau đó chạy <code>rarp ui</code> để lấy liên
            kết kết nối.
          </section>
        ) : (
          <>
            <div className="summary">
              <span>
                <b>{snapshot.tasks.length}</b> task
              </span>
              <span>
                <b>
                  {
                    snapshot.tasks.filter((t) =>
                      ["running", "reviewing"].includes(t.status),
                    ).length
                  }
                </b>{" "}
                đang xử lý
              </span>
              <span>
                <b>
                  {snapshot.tasks.filter((t) => t.status === "accepted").length}
                </b>{" "}
                đã nghiệm thu
              </span>
              <span>
                <b>{workers.length}</b> worker đã đăng ký
              </span>
            </div>
            {view === "board" && (
              <>
                <div className="section-title">
                  <h2>Bảng công việc</h2>
                  <label className="search">
                    <span>Tìm task</span>
                    <input
                      value={filter}
                      placeholder="Tên, worker hoặc ID…"
                      onChange={(e) => setFilter(e.target.value)}
                    />
                  </label>
                </div>
                {!visible.length ? (
                  <section className="empty">
                    {snapshot.tasks.length
                      ? "Không có task khớp tìm kiếm."
                      : "Chưa có công việc. Tạo task để bắt đầu."}
                  </section>
                ) : (
                  <div className="board">
                    {[
                      ["Chờ thực hiện", ["queued", "blocked"]],
                      ["Đang xử lý", ["running", "submitted", "reviewing"]],
                      ["Cần chú ý", ["failed", "changes_requested"]],
                      ["Hoàn tất", ["accepted", "cancelled"]],
                    ].map(([label, statuses]) => (
                      <section className="column" key={String(label)}>
                        <h3>
                          {label}
                          <span>
                            {
                              visible.filter((t) =>
                                (statuses as string[]).includes(t.status),
                              ).length
                            }
                          </span>
                        </h3>
                        {visible
                          .filter((t) =>
                            (statuses as string[]).includes(t.status),
                          )
                          .map((t) => (
                            <button
                              className={
                                "task-card " +
                                (selected === t.id ? "selected" : "")
                              }
                              key={t.id}
                              onClick={() => {
                                setSelected(t.id);
                                setTab("overview");
                                setActor(t.created_by);
                                setNote("");
                              }}
                            >
                              <Badge status={t.status} />
                              <h4>{t.title}</h4>
                              <p>
                                {t.assigned_to} <span>· {short(t.id)}</span>
                              </p>
                              <small>
                                {t.workspace?.integrated
                                  ? "Đã tích hợp"
                                  : t.dependencies.length
                                    ? `${t.dependencies.length} phụ thuộc`
                                    : "Không có phụ thuộc"}
                              </small>
                            </button>
                          ))}
                      </section>
                    ))}
                  </div>
                )}
                <section className="dependency">
                  <h2>Quan hệ phụ thuộc</h2>
                  <p className="muted">
                    Task phụ thuộc cần được nghiệm thu; kết quả worktree cần
                    tích hợp trước khi chạy task tiếp.
                  </p>
                  {snapshot.tasks
                    .filter((t) => t.dependencies.length)
                    .map((t) => (
                      <div className="dependency-row" key={t.id}>
                        {t.dependencies.map((id) => {
                          const dep = snapshot.tasks.find((d) => d.id === id);
                          return (
                            <button
                              key={id}
                              onClick={() => {
                                setSelected(id);
                                setActor(dep?.created_by ?? "");
                              }}
                            >
                              {dep?.title ?? short(id)}{" "}
                              <span>{names[dep?.status ?? ""]}</span>
                            </button>
                          );
                        })}
                        <span aria-label="phụ thuộc tới">→</span>
                        <button
                          onClick={() => {
                            setSelected(t.id);
                            setActor(t.created_by);
                          }}
                        >
                          {t.title}
                        </button>
                      </div>
                    ))}
                  {!snapshot.tasks.some((t) => t.dependencies.length) && (
                    <p className="muted">Chưa có quan hệ phụ thuộc.</p>
                  )}
                </section>
              </>
            )}
            {view === "agents" && (
              <section>
                <div className="section-title">
                  <h2>Manager và worker</h2>
                </div>
                {snapshot.agents.map((a) => (
                  <div className="agent-row" key={a.id}>
                    <div>
                      <strong>{a.id}</strong>
                      <small>
                        {a.role === "manager"
                          ? "Manager · giao việc và nghiệm thu"
                          : "Worker · thực hiện task"}
                      </small>
                    </div>
                    <span>
                      {snapshot.tasks.find(
                        (t) =>
                          snapshot.runtime.active?.taskId === t.id &&
                          (a.role === "manager"
                            ? t.created_by === a.id && t.status === "reviewing"
                            : t.assigned_to === a.id && t.status === "running"),
                      )?.title ?? "Chưa có task đang chạy"}
                    </span>
                  </div>
                ))}
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void action("Đăng ký agent", () =>
                      api("agents", Object.fromEntries(data)),
                    );
                  }}
                >
                  <label>
                    ID agent
                    <input name="id" required maxLength={128} />
                  </label>
                  <label>
                    Vai trò
                    <select name="role">
                      <option value="worker">Worker</option>
                      <option value="manager">Manager</option>
                    </select>
                  </label>
                  <button disabled={pending}>Đăng ký</button>
                </form>
              </section>
            )}
            {view === "timeline" && (
              <section>
                <h2>Sự kiện gần nhất</h2>
                <p className="muted">
                  Hiển thị tối đa 200 sự kiện gần nhất. Log theo task có phân
                  trang trong chi tiết task.
                </p>
                <EventList
                  events={events}
                  select={(id) => {
                    setSelected(id);
                    setActor(
                      snapshot.tasks.find((t) => t.id === id)?.created_by ?? "",
                    );
                  }}
                />
              </section>
            )}
          </>
        )}
        <footer>
          Rarp · Dữ liệu trên máy local{" "}
          <span>
            {snapshot ? `Cursor #${snapshot.lastEventId}` : "Chưa có snapshot"}
          </span>
        </footer>
      </main>
      {task && (
        <div className="drawer-backdrop" onClick={() => setSelected("")}>
          <section
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label={"Chi tiết " + task.title}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-head">
              <div>
                <span className="eyebrow">TASK {short(task.id)}</span>
                <h2>{task.title}</h2>
              </div>
              <button
                aria-label="Đóng chi tiết"
                onClick={() => setSelected("")}
              >
                Đóng
              </button>
            </div>
            <Badge status={task.status} />
            {error && (
              <p role="alert" className="alert">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="notice">
                {notice}
              </p>
            )}
            <div className="tabs">
              {[
                ["overview", "Tổng quan"],
                ["evidence", "Diff & kiểm thử"],
                ["logs", "Log"],
              ].map(([id, label]) => (
                <button
                  aria-pressed={tab === id}
                  key={id}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "overview" && (
              <>
                <p className="body-text">{task.body || "Chưa có mô tả."}</p>
                <dl>
                  <dt>Worker</dt>
                  <dd>{task.assigned_to}</dd>
                  <dt>Manager</dt>
                  <dd>{task.created_by}</dd>
                  <dt>Phụ thuộc</dt>
                  <dd>
                    {task.dependencies
                      .map(
                        (id) =>
                          snapshot?.tasks.find((t) => t.id === id)?.title ?? id,
                      )
                      .join(", ") || "Không có"}
                  </dd>
                  <dt>Worktree</dt>
                  <dd>{task.workspace?.path ?? "Thư mục dự án"}</dd>
                </dl>
                <h3>Thao tác</h3>
                <label>
                  Thực hiện với manager
                  <select
                    value={actor}
                    onChange={(e) => setActor(e.target.value)}
                  >
                    <option value="">Chọn manager</option>
                    {managers.map((a) => (
                      <option key={a.id}>{a.id}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Ghi chú / lý do
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Bằng chứng nghiệm thu, phản hồi hoặc lý do retry…"
                  />
                </label>
                <div className="actions">
                  <button
                    disabled={
                      pending ||
                      !note ||
                      !actor ||
                      !["failed", "blocked", "changes_requested"].includes(
                        task.status,
                      )
                    }
                    onClick={() => transition("queued")}
                  >
                    Đưa lại hàng chờ
                  </button>
                  <button
                    disabled={
                      pending ||
                      !note ||
                      actor !== task.created_by ||
                      task.status !== "submitted"
                    }
                    onClick={() => transition("reviewing")}
                  >
                    Bắt đầu review
                  </button>
                  <button
                    disabled={
                      pending ||
                      !note ||
                      actor !== task.created_by ||
                      task.status !== "reviewing"
                    }
                    onClick={() => transition("accepted")}
                  >
                    Nghiệm thu
                  </button>
                  <button
                    disabled={
                      pending ||
                      !note ||
                      actor !== task.created_by ||
                      task.status !== "reviewing"
                    }
                    onClick={() => transition("changes_requested")}
                  >
                    Yêu cầu sửa
                  </button>
                  <button
                    disabled={
                      pending ||
                      !task.workspace ||
                      task.status !== "accepted" ||
                      !!task.workspace.integrated
                    }
                    onClick={() =>
                      void action("Tích hợp", () =>
                        api("integrate", { taskId: task.id }),
                      )
                    }
                  >
                    {task.workspace?.integrated
                      ? "Đã tích hợp"
                      : "Tích hợp commit"}
                  </button>
                  <button
                    className="danger"
                    disabled={
                      pending ||
                      !note ||
                      actor !== task.created_by ||
                      ["accepted", "cancelled"].includes(task.status) ||
                      snapshot?.runtime.active?.taskId === task.id
                    }
                    onClick={() => transition("cancelled")}
                  >
                    Hủy task
                  </button>
                </div>
                {snapshot?.runtime.active?.taskId === task.id ? (
                  <button
                    className="danger"
                    disabled={pending}
                    onClick={() =>
                      void action("Dừng workflow", () =>
                        api("cancel", { taskId: task.id }),
                      )
                    }
                  >
                    Dừng workflow này
                  </button>
                ) : (
                  <>
                    {[
                      "queued",
                      "failed",
                      "blocked",
                      "changes_requested",
                    ].includes(task.status) && (
                      <label>
                        Đổi worker
                        <select
                          value={task.assigned_to}
                          disabled={
                            pending || !note || actor !== task.created_by
                          }
                          onChange={(e) =>
                            void action("Đổi worker", () =>
                              api("reassign", {
                                taskId: task.id,
                                actor,
                                expectedStatus: task.status,
                                assignee: e.target.value,
                                note,
                              }),
                            )
                          }
                        >
                          {workers.map((w) => (
                            <option key={w.id}>{w.id}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {["queued", "submitted"].includes(task.status) && (
                      <form
                        className="run-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action("Khởi chạy workflow", () =>
                            api("workflow", {
                              taskId: task.id,
                              adapter,
                              isolated: true,
                              resumeReview: task.status === "submitted",
                              scope: task.workspace
                                ? []
                                : scope
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                              check: task.workspace ? [] : JSON.parse(check),
                              requestKey: crypto.randomUUID(),
                            }),
                          );
                        }}
                      >
                        <h3>
                          {task.status === "submitted"
                            ? "Tiếp tục review"
                            : "Chạy trong worktree riêng"}
                        </h3>
                        <label>
                          Worker adapter
                          <select
                            value={adapter}
                            onChange={(e) => setAdapter(e.target.value)}
                          >
                            <option value="codex">Codex</option>
                            <option value="antigravity">Antigravity</option>
                          </select>
                        </label>
                        {!task.workspace && (
                          <>
                            <label>
                              Phạm vi file (phân cách bằng dấu phẩy)
                              <input
                                value={scope}
                                onChange={(e) => setScope(e.target.value)}
                                required
                              />
                            </label>
                            <label>
                              Lệnh kiểm thử (JSON argv)
                              <input
                                value={check}
                                onChange={(e) => setCheck(e.target.value)}
                                required
                              />
                            </label>
                          </>
                        )}
                        <button
                          className="primary"
                          disabled={pending || !!snapshot?.runtime.active}
                        >
                          {pending
                            ? "Đang xử lý…"
                            : task.status === "submitted"
                              ? "Chạy reviewer"
                              : "Chạy workflow"}
                        </button>
                      </form>
                    )}
                  </>
                )}
                <h3>Lịch sử review</h3>
                {task.reviews.length ? (
                  task.reviews.map((r) => (
                    <article className="review" key={r.id}>
                      <Badge status={r.decision} />
                      <small>{r.reviewer}</small>
                      <pre>{r.feedback}</pre>
                    </article>
                  ))
                ) : (
                  <p className="muted">Chưa có quyết định review.</p>
                )}
              </>
            )}
            {tab === "evidence" && (
              <>
                <h3>Commit và kiểm thử</h3>
                <dl>
                  <dt>Base</dt>
                  <dd>{task.workspace?.base ?? "—"}</dd>
                  <dt>Checkpoint</dt>
                  <dd>{task.workspace?.commit ?? "—"}</dd>
                  <dt>Tích hợp</dt>
                  <dd>{task.workspace?.integrated ?? "Chưa tích hợp"}</dd>
                </dl>
                {task.attempts.map((a) => (
                  <details key={a.id} open>
                    <summary>
                      Attempt {a.number} · {a.outcome ?? "đang chạy"}
                    </summary>
                    <pre>{a.summary ?? "Chưa có kết quả nộp."}</pre>
                  </details>
                ))}
                {task.workspace?.integrationEvidence && (
                  <details open>
                    <summary>Kiểm thử sau tích hợp</summary>
                    <pre>{task.workspace.integrationEvidence}</pre>
                  </details>
                )}
                <h3>Diff checkpoint</h3>
                <p className="muted">{diff?.message ?? "Đang tải diff…"}</p>
                <pre>{diff?.stat}</pre>
                <pre className="diff">
                  {diff?.diff.split("\n").map((line, i) => (
                    <span
                      key={i}
                      className={
                        line.startsWith("+")
                          ? "addition"
                          : line.startsWith("-")
                            ? "deletion"
                            : ""
                      }
                    >
                      {line}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              </>
            )}
            {tab === "logs" && (
              <>
                <p className="muted">
                  Trang log từ cũ đến mới; sự kiện trực tiếp được cập nhật ở
                  cuối.
                </p>
                <EventList events={taskEvents} />
                {more && (
                  <button
                    disabled={pending}
                    onClick={() =>
                      void action("Tải trang log", async () => {
                        const page = await api<{
                          events: Row[];
                          nextCursor: number;
                          hasMore: boolean;
                        }>(
                          `events?taskId=${encodeURIComponent(task.id)}&after=${cursor}&limit=100`,
                        );
                        setLog((old) => mergeEvents(old, page.events, 1000));
                        setCursor(page.nextCursor);
                        setMore(page.hasMore);
                      })
                    }
                  >
                    Tải trang tiếp
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {create && (
        <div className="drawer-backdrop">
          <section
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Tạo task"
          >
            <div className="drawer-head">
              <h2>Tạo công việc</h2>
              <button onClick={() => setCreate(false)}>Đóng</button>
            </div>
            {error && (
              <p role="alert" className="alert">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="notice">
                {notice}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void action("Tạo task", async () => {
                  await api("tasks", {
                    title: data.get("title"),
                    body: data.get("body"),
                    actor: data.get("actor"),
                    assignee: data.get("assignee"),
                    dependencies: data.getAll("dependencies"),
                  });
                  setCreate(false);
                });
              }}
            >
              <label>
                Tiêu đề
                <input name="title" required maxLength={240} />
              </label>
              <label>
                Yêu cầu
                <textarea name="body" rows={7} maxLength={20000} />
              </label>
              <label>
                Manager
                <select name="actor" required>
                  {managers.map((a) => (
                    <option key={a.id}>{a.id}</option>
                  ))}
                </select>
              </label>
              <label>
                Worker
                <select name="assignee" required>
                  {workers.map((a) => (
                    <option key={a.id}>{a.id}</option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>Phụ thuộc</legend>
                {snapshot?.tasks.map((t) => (
                  <label className="checkbox" key={t.id}>
                    <input type="checkbox" name="dependencies" value={t.id} />
                    {t.title}
                  </label>
                ))}
                {!snapshot?.tasks.length && (
                  <p className="muted">Chưa có task để chọn.</p>
                )}
              </fieldset>
              <button
                className="primary"
                disabled={pending || !managers.length || !workers.length}
              >
                {pending ? "Đang tạo…" : "Tạo task"}
              </button>
              {(!managers.length || !workers.length) && (
                <p>Đăng ký manager và worker ở màn hình Agent trước.</p>
              )}
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function EventList({
  events,
  select,
}: {
  events: Row[];
  select?: (id: string) => void;
}) {
  return (
    <div className="event-list">
      {!events.length && <p className="muted">Chưa có sự kiện.</p>}
      {events.map((event) => (
        <details key={event.id}>
          <summary>
            <span className="event-id">#{event.id}</span>
            <time>
              {new Date(event.created_at).toLocaleTimeString("vi-VN")}
            </time>
            <strong>{event.type}</strong>
            <span>{event.agent_id ?? "runtime"}</span>
          </summary>
          {event.task_id && select && (
            <button onClick={() => select(event.task_id!)}>
              Mở task {short(event.task_id)}
            </button>
          )}
          <pre>{formatPayload(event.payload)}</pre>
        </details>
      ))}
    </div>
  );
}
function formatPayload(payload: string) {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}
createRoot(document.getElementById("root")!).render(<App />);
