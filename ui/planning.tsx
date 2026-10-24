import { useEffect, useState } from "react";
import { api } from "./client";
import type { Goal, Plan, Proposal, Approval } from "../src/core/plan";

type Profile = { id:string; adapter:string; profile:string; model:string|null; available:boolean; supported:boolean; authenticated:boolean|null };
type Detail = Plan & { waves: string[][]; history: unknown[]; tasks: { stepKey: string; taskId: string; task: {status:string; title:string}; workspace?: {integrated:boolean} }[]; logs: unknown[] };
const stateNames: Record<string,string> = {received:"Đã nhận", analyzing:"Đang phân tích", needs_clarification:"Cần làm rõ", awaiting_approval:"Chờ duyệt", executing:"Đang thực thi", completed:"Hoàn tất", paused:"Tạm dừng", failed:"Lỗi", rejected:"Đã từ chối", cancelled:"Đã hủy", revision_requested:"Cần phân tích lại"};
export function Planning({ maxWorkers, maxReviewers, eventId }: { maxWorkers:number; maxReviewers:number; eventId:number }) {
  const [plans,setPlans]=useState<Plan[]>([]), [goals,setGoals]=useState<Goal[]>([]), [id,setId]=useState(sessionStorage.getItem("rarp-plan")??""), [detail,setDetail]=useState<Detail|null>(null);
  const [title,setTitle]=useState(localStorage.getItem("rarp-goal-title")??""), [requirements,setRequirements]=useState(localStorage.getItem("rarp-goal-requirements")??""), [acceptance,setAcceptance]=useState(localStorage.getItem("rarp-goal-acceptance")??""), [limit,setLimit]=useState(Math.min(4,maxWorkers));
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[edit,setEdit]=useState(""),[clarification,setClarification]=useState(""),[bindings,setBindings]=useState<Approval["workers"]>([]),[slots,setSlots]=useState(1),[reviewers,setReviewers]=useState(1),[integration,setIntegration]=useState<Approval["integration"]>("reviewed-local"),[confirm,setConfirm]=useState(false);
  const [profiles,setProfiles]=useState<Profile[]>([]);
  async function refresh() { const [p,g,available]=await Promise.all([api<{plans:Plan[]}>("plans"),api<{goals:Goal[]}>("goals"),api<{profiles:Profile[]}>("profiles")]);setPlans(p.plans);setGoals(g.goals);setProfiles(available.profiles);if(id)setDetail(await api<Detail>("plans/"+encodeURIComponent(id))); }
  useEffect(()=>{void refresh().catch(e=>setError(String(e)));},[id,eventId]);
  useEffect(()=>{sessionStorage.setItem("rarp-plan",id);setDetail(null);setEdit("");setConfirm(false);},[id]);
  useEffect(()=>{if(!detail || detail.status!=="awaiting_approval")return;localStorage.setItem(`rarp-bindings-${detail.id}-${detail.revision}`,JSON.stringify(bindings));},[bindings]);
  useEffect(()=>{localStorage.setItem("rarp-goal-title",title);localStorage.setItem("rarp-goal-requirements",requirements);localStorage.setItem("rarp-goal-acceptance",acceptance);},[title,requirements,acceptance]);
  useEffect(()=>{const p=detail?.proposal;if(!p)return;let saved: Approval["workers"] | undefined;try{const value:unknown=JSON.parse(localStorage.getItem(`rarp-bindings-${detail.id}-${detail.revision}`)??"null");if(Array.isArray(value)&&value.length===p.workers.length&&value.every((w,i)=>w?.workerRef===p.workers[i]?.workerRef&&["codex","antigravity"].includes(w.adapter)&&typeof w.profile==="string"))saved=value;}catch{}setBindings(detail.approval?.workers??saved??p.workers.map(w=>({workerRef:w.workerRef,adapter:"codex",profile:"default"})));setSlots(detail.approval?.maxWorkers??p.maxWorkers);setReviewers(detail.approval?.maxReviewers??1);setIntegration(detail.approval?.integration??"reviewed-local");setConfirm(false);},[detail?.id,detail?.revision]);
  async function run(fn:()=>Promise<void>) {if(busy)return;setBusy(true);setError("");try{await fn();await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}}
  const proposal=detail?.proposal, editable=!!detail&&["received","awaiting_approval","needs_clarification","failed","revision_requested","rejected","paused"].includes(detail.status), goal=goals.find(g=>g.id===detail?.goalId);
  function control(action:string){void run(async()=>{setDetail(await api<Detail>(`plans/${id}/${action}`,{}));});}
  return <section className="planning" aria-label="Lập kế hoạch mục tiêu">
    <h2>Mục tiêu → Đề xuất → Chọn CLI & duyệt → Thực thi</h2>
    <p className="muted">Chỉ phân tích trước khi duyệt. Không khởi chạy worker, build hay test tự động ở bước đề xuất.</p>
    {error&&<p role="alert" className="alert">{error}</p>}
    <label>Kế hoạch đã lưu<select value={id} onChange={e=>setId(e.target.value)}><option value="">Mục tiêu mới</option>{plans.map(p=><option key={p.id} value={p.id}>{goals.find(g=>g.id===p.goalId)?.title??p.id} · r{p.revision} · {stateNames[p.status]??p.status}</option>)}</select></label>
    {!id?<form onSubmit={e=>{e.preventDefault();void run(async()=>{const created=await api<{goal:Goal;plan:Plan}>("goals",{title,requirements,acceptance:acceptance.split("\n").map(s=>s.trim()).filter(Boolean),maxWorkers:limit});setId(created.plan.id);});}}>
      <label>Mục tiêu<input required maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
      <label>Yêu cầu<textarea required value={requirements} onChange={e=>setRequirements(e.target.value)}/></label>
      <label>Nghiệm thu (mỗi dòng một tiêu chí quan sát được)<textarea required value={acceptance} onChange={e=>setAcceptance(e.target.value)}/></label>
      <label>Giới hạn worker<input type="number" min={1} max={Math.min(16,maxWorkers)} value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label>
      <button disabled={busy} className="primary">Lưu mục tiêu</button>
    </form>:!detail?<p>Đang tải kế hoạch…</p>:<>
      <h3>{goal?.title} · {stateNames[detail.status]??detail.status}</h3><p>{goal?.requirements}</p>
      <p>Revision {detail.revision} · HEAD <code>{detail.baseHead||"chưa phân tích"}</code></p><p className="plan-hash">Hash <code>{detail.contentHash||"chưa có"}</code></p>
      {detail.note&&<p role="status">{detail.note}</p>}
      {editable&&<><label>Làm rõ / yêu cầu lập lại<textarea value={clarification} onChange={e=>setClarification(e.target.value)}/></label><button disabled={busy} onClick={()=>void run(async()=>{setDetail(await api<Detail>(`plans/${id}/analyze`,{clarification}));})}>Phân tích read-only / lập lại</button></>}
      {proposal&&<>
        <h3>Đề xuất</h3><p>{proposal.understood}</p><p>{proposal.rationale}</p>
        <p>{proposal.steps.length} đầu việc · {proposal.workers.length} worker · {proposal.maxWorkers} slot · kích thước {proposal.size} · độ tin cậy {proposal.confidence}</p>
        <p>Wave: {detail.waves.map(w=>w.join(", ")).join(" → ")}</p>
        <h4>Giả định</h4><ul>{proposal.assumptions.map((s,i)=><li key={i}>{s}</li>)}</ul>
        {proposal.questions.length>0&&<><h4>Cần trả lời trước khi duyệt</h4><ul>{proposal.questions.map((s,i)=><li key={i}>{s}</li>)}</ul></>}
        {proposal.steps.map(s=><article className="plan-step" key={s.key}><h4>{s.key}: {s.title} · {s.workerRef}</h4><p>{s.requirements}</p><p>Đầu ra: {s.deliverable}</p><p>Phụ thuộc: {s.dependencies.join(", ")||"không"} · Scope: <code>{s.scope.join(", ")}</code></p><p>Kiểm thử argv: <code>{JSON.stringify(s.check)}</code></p><ul>{s.acceptance.map((a,i)=><li key={i}>{a}</li>)}</ul></article>)}
        <p>Review tối đa {proposal.policy.maxRounds} vòng · mỗi lượt {proposal.policy.timeoutMs} ms · tổng {proposal.policy.totalTimeoutMs} ms</p>
        {editable&&<><button disabled={busy} onClick={()=>setEdit(edit?"":JSON.stringify(proposal,null,2))}>{edit?"Đóng chỉnh sửa":"Sửa đề xuất JSON"}</button>{edit&&<><label>Đề xuất JSON<textarea className="plan-json" value={edit} onChange={e=>setEdit(e.target.value)}/></label><button disabled={busy} onClick={()=>void run(async()=>{setDetail(await api<Detail>(`plans/${id}/update`,{revision:detail.revision,proposal:JSON.parse(edit) as Proposal}));setEdit("");})}>Lưu revision mới</button></>}</>}
        {detail.status==="awaiting_approval"&&<fieldset disabled={busy}><legend>Chọn CLI & duyệt</legend>
          {bindings.map((w,i)=><div className="plan-binding" key={w.workerRef}><strong>{w.workerRef}</strong><span>{proposal.workers.find(p=>p.workerRef===w.workerRef)?.rationale}</span><label>CLI<select value={w.adapter} onChange={e=>{setBindings(old=>old.map((b,j)=>j===i?{...b,adapter:e.target.value as "codex"|"antigravity"}:b));setConfirm(false);}}><option value="codex">Codex</option><option value="antigravity">Antigravity (cần cấu hình)</option></select></label><label>Profile<input required value={w.profile} onChange={e=>{setBindings(old=>old.map((b,j)=>j===i?{...b,profile:e.target.value}:b));setConfirm(false);}}/></label></div>)}
          <p>Executable/model lấy từ profile runtime. CLI/profile thiếu sẽ bị từ chối; không fallback.</p>
          <ul>{profiles.map(p=><li key={p.id}><code>{p.id}</code> · model: {p.model??"chưa cấu hình"} · {!p.supported?"chưa hỗ trợ":!p.available?"thiếu executable":p.authenticated===false?"chưa đăng nhập":"có sẵn; kiểm tra đăng nhập khi duyệt"}</li>)}</ul>
          <label>Slot thực thi<input type="number" min={1} max={Math.min(maxWorkers,proposal.maxWorkers)} value={slots} onChange={e=>{setSlots(Number(e.target.value));setConfirm(false);}}/></label>
          <label>Reviewer đồng thời<input type="number" min={1} max={maxReviewers} value={reviewers} onChange={e=>{setReviewers(Number(e.target.value));setConfirm(false);}}/></label>
          <label>Tích hợp<select value={integration} onChange={e=>{setIntegration(e.target.value as Approval["integration"]);setConfirm(false);}}><option value="reviewed-local">Tích hợp local sau nghiệm thu</option><option value="manual">Chờ tích hợp thủ công</option></select></label>
          <label><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>Đã xem revision {detail.revision}, phạm vi, lệnh kiểm thử, CLI/profile và giới hạn trên.</label>
          <button className="primary" disabled={!confirm||!!edit} onClick={()=>void run(async()=>{setDetail(await api<Detail>(`plans/${id}/approve`,{revision:detail.revision,contentHash:detail.contentHash,actor:"human",maxWorkers:slots,maxReviewers:reviewers,workers:bindings,integration} satisfies Approval));setConfirm(false);})}>Duyệt và chạy</button>
        </fieldset>}
      </>}
      <div className="toolbar">{editable&&detail.status!=="paused"&&<button disabled={busy} onClick={()=>control("reject")}>Từ chối</button>}{detail.status==="executing"&&<button disabled={busy} onClick={()=>control("pause")}>Tạm dừng kế hoạch</button>}{detail.status==="paused"&&<button disabled={busy} onClick={()=>control("resume")}>Tiếp tục kế hoạch</button>}{!["completed","cancelled","rejected"].includes(detail.status)&&<button disabled={busy} onClick={()=>control("cancel")}>Hủy riêng kế hoạch</button>}</div>
      {!!detail.tasks.length&&<><h3>Thực thi</h3><ul>{detail.tasks.map(t=><li key={t.taskId}>{t.task.title} · {t.task.status} · {t.workspace?.integrated?"đã tích hợp":"chưa tích hợp"}</li>)}</ul></>}
      {detail.history?.length>0&&<details><summary>Lịch sử revision (so sánh đề xuất cũ)</summary><pre>{JSON.stringify(detail.history,null,2)}</pre></details>}
      <details><summary>Nhật ký phân tích riêng</summary><pre>{JSON.stringify(detail.logs,null,2)}</pre></details>
    </>}
  </section>;
}
