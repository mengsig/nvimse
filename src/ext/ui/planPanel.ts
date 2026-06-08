import * as vscode from "vscode";
import { listPlans, getPlan, createPlan, overallStatus, setStepStatus, resetSession, deletePlan, Plan } from "../plan";
import { executeStep, nextPendingStep, addTestForStep } from "../planExec";
import { currentProvider } from "../services";
import { escapeHtml, panelShell } from "./webviewHtml";

let panel: vscode.WebviewPanel | undefined;
let currentPlanId: string | null = null;

export function openPlanPanel(planId?: string): void {
  if (planId) currentPlanId = planId;
  if (!panel) {
    panel = vscode.window.createWebviewPanel("nvimsePlan", "nvimse Plans", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.onDidDispose(() => (panel = undefined));
    panel.webview.onDidReceiveMessage(onMessage);
  }
  panel.reveal();
  render();
}

/** Reveal the plan UI if open (port of :NvimePlanFocus). */
export function focusPlanPanel(): void {
  if (panel) panel.reveal();
  else openPlanPanel();
}

/** Tear down the plan UI (port of :NvimePlanClose). */
export function closePlanPanel(): void {
  panel?.dispose();
  panel = undefined;
}

export async function newPlan(): Promise<void> {
  const intent = await vscode.window.showInputBox({ prompt: "nvimse plan · describe the change to plan", placeHolder: "e.g. Add retry with backoff to the HTTP client" });
  if (!intent) return;
  openPlanPanel();
  setBusy(true);
  const plan = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "nvimse: drafting plan…", cancellable: false },
    () => createPlan(intent, currentProvider())
  );
  setBusy(false);
  if (plan) {
    currentPlanId = plan.id;
    render();
    vscode.window.showInformationMessage(`nvimse: drafted plan ${plan.id} (${plan.steps.length} steps)`);
  } else {
    vscode.window.showWarningMessage("nvimse: plan author produced no plan");
    render();
  }
}

let busy = false;
function setBusy(v: boolean): void {
  busy = v;
  if (panel) render();
}

function onMessage(m: any): void {
  if (m.type === "open") {
    currentPlanId = m.id;
    render();
  } else if (m.type === "back") {
    currentPlanId = null;
    render();
  } else if (m.type === "new") {
    newPlan();
  } else if (m.type === "run" && currentPlanId) {
    executeStep(currentPlanId, m.stepId).then(() => render());
  } else if (m.type === "runNext" && currentPlanId) {
    const plan = getPlan(currentPlanId);
    const next = plan && nextPendingStep(plan);
    if (next) executeStep(currentPlanId, next.id).then(() => render());
  } else if (m.type === "status" && currentPlanId) {
    setStepStatus(currentPlanId, m.stepId, m.status);
    render();
  } else if (m.type === "resetSession" && currentPlanId) {
    resetSession(currentPlanId);
    render();
  } else if (m.type === "addTest" && currentPlanId) {
    addTestForStep(currentPlanId, m.stepId).then(() => render());
  } else if (m.type === "openFile" && currentPlanId) {
    const plan = getPlan(currentPlanId);
    const step = plan?.steps.find((s) => s.id === m.stepId);
    if (step) vscode.workspace.openTextDocument(step.file).then((d) => vscode.window.showTextDocument(d));
  } else if (m.type === "delete") {
    const id = m.id || currentPlanId;
    if (!id) return;
    vscode.window.showWarningMessage(`Delete plan ${id}?`, { modal: true }, "Delete").then((pick) => {
      if (pick === "Delete") {
        deletePlan(id);
        if (currentPlanId === id) currentPlanId = null;
        render();
      }
    });
  }
}

function render(): void {
  if (!panel) return;
  if (currentPlanId) {
    const plan = getPlan(currentPlanId);
    if (plan) {
      panel.webview.html = planViewHtml(plan);
      return;
    }
    currentPlanId = null;
  }
  panel.webview.html = pickerHtml();
}

const STATUS_ICON: Record<string, string> = {
  pending: "●",
  in_progress: "◐",
  done: "✓",
  blocked: "⚠",
  abandoned: "✗",
};

function pickerHtml(): string {
  const plans = listPlans();
  const rows = plans
    .map((p) => {
      const st = overallStatus(p);
      const done = p.steps.filter((s) => s.status === "done").length;
      return `<div class="row" onclick="post({type:'open',id:'${escapeHtml(p.id)}'})">
        <span class="badge ${st}">${st}</span>
        <span class="title">${escapeHtml(p.title || p.id)}</span>
        <span class="meta">${escapeHtml(p.id)} · ${done}/${p.steps.length} steps</span>
      </div>`;
    })
    .join("");
  return shell(
    "nvimse · plans",
    `<button class="primary" onclick="post({type:'new'})">＋ New plan${busy ? " (drafting…)" : ""}</button>
     <div class="list">${rows || '<div class="empty">No plans yet. Draft one.</div>'}</div>`
  );
}

function planViewHtml(plan: Plan): string {
  const st = overallStatus(plan);
  const done = plan.steps.filter((s) => s.status === "done").length;
  const pct = plan.steps.length ? Math.round((done / plan.steps.length) * 100) : 0;
  const steps = plan.steps
    .map((s) => {
      const range = s.range === "new" ? "new file" : `L${s.range.line1}-${s.range.line2}`;
      return `<div class="step ${s.status}">
        <div class="step-head"><span class="badge ${s.status}">${STATUS_ICON[s.status]} ${s.status}</span>
          <b>Step ${s.id}</b> <span class="meta">${escapeHtml(s.file)} · ${range}</span></div>
        <div class="intent">${escapeHtml(s.intent)}</div>
        ${s.notes ? `<div class="notes">${escapeHtml(s.notes)}</div>` : ""}
        ${s.tests.length ? `<div class="tests">tests: ${escapeHtml(s.tests.join(" && "))}</div>` : ""}
        <div class="actions">
          <button onclick="post({type:'run',stepId:${s.id}})">▶ Run</button>
          <button onclick="post({type:'addTest',stepId:${s.id}})">⊕ add test</button>
          <button onclick="post({type:'openFile',stepId:${s.id}})">open file</button>
          <button onclick="post({type:'status',stepId:${s.id},status:'done'})">✓ done</button>
          <button onclick="post({type:'status',stepId:${s.id},status:'pending'})">↺ pending</button>
          <button onclick="post({type:'status',stepId:${s.id},status:'blocked'})">⚠ blocked</button>
        </div>
      </div>`;
    })
    .join("");
  const acceptance = plan.acceptance.map((a) => `<li>${escapeHtml(a.text)}</li>`).join("");
  return shell(
    `nvimse · ${escapeHtml(plan.title || plan.id)}`,
    `<div class="toolbar">
       <button onclick="post({type:'back'})">‹ all plans</button>
       <button class="primary" onclick="post({type:'runNext'})">▶ Run next pending</button>
       <button onclick="post({type:'resetSession'})">↻ reset session</button>
       <button onclick="post({type:'delete'})">🗑 delete</button>
       <span class="badge ${st}">${st}</span>
       <span class="meta">${done}/${plan.steps.length} steps · ${pct}%</span>
     </div>
     <div class="why"><b>WHY</b><div>${escapeHtml(plan.why || "")}</div></div>
     ${acceptance ? `<div class="acc"><b>ACCEPTANCE</b><ul>${acceptance}</ul></div>` : ""}
     <div class="steps">${steps}</div>`
  );
}

function shell(title: string, body: string): string {
  return panelShell(title, body, {
    css: `
  .row{padding:10px;border:1px solid #2f334d;border-radius:6px;margin:6px 0;cursor:pointer;}
  .row:hover{border-color:#82aaff;}
  .title{font-weight:bold;color:#c3e88d;} .meta{margin-left:8px;}
  .badge{padding:1px 7px;border-radius:4px;font-size:11px;margin-right:6px;}
  .badge.done{background:#1f3d2b;color:#c3e88d;} .badge.pending{background:#2f334d;color:#828bb8;}
  .badge.in_progress{background:#3d3a1f;color:#ffc777;} .badge.blocked,.badge.abandoned{background:#3d2222;color:#ff757f;}
  .step{border:1px solid #2f334d;border-radius:6px;padding:10px;margin:8px 0;}
  .step.done{border-color:#3d5a40;} .step.blocked{border-color:#5a3030;}
  .intent{margin:6px 0;white-space:pre-wrap;}
  .notes{color:#828bb8;font-style:italic;} .tests{color:#86e1fc;font-size:12px;margin-top:4px;}
  .why,.acc{margin:10px 0;padding:8px;border:1px solid #2f334d;border-radius:6px;}
  .toolbar{margin-bottom:10px;}`,
  });
}
