import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Eye,
  FolderOpen,
  Inbox,
  Loader2,
  MailCheck,
  MousePointerClick,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Tag,
  Trash2,
} from "lucide-react";
import "./styles.css";

const actionIcons = {
  label: Tag,
  archive: Archive,
  mark_read: MailCheck,
  trash: Trash2,
};

const views = [
  { id: "run", label: "Run Rules", icon: Play },
  { id: "rules", label: "Rules", icon: Settings },
  { id: "labels", label: "Labels", icon: FolderOpen },
  { id: "unsubscribe", label: "Unsubscribe", icon: MousePointerClick },
  { id: "history", label: "History", icon: Clock3 },
];

function App() {
  const [view, setView] = useState("run");
  const [health, setHealth] = useState(null);
  const [rules, setRules] = useState([]);
  const [draftRules, setDraftRules] = useState([]);
  const [labels, setLabels] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [limit, setLimit] = useState(50);
  const [samples, setSamples] = useState(5);
  const [plan, setPlan] = useState(null);
  const [history, setHistory] = useState([]);
  const [labelSamples, setLabelSamples] = useState({});
  const [labelFilter, setLabelFilter] = useState("");
  const [unsubscribeQuery, setUnsubscribeQuery] = useState("in:inbox");
  const [unsubscribeCandidates, setUnsubscribeCandidates] = useState([]);
  const [unsubscribeSelected, setUnsubscribeSelected] = useState(new Set());
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(null);

  useEffect(() => {
    refreshAll();
  }, []);

  async function api(path, options) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed: ${response.status}`);
    return data;
  }

  async function refreshAll() {
    setError("");
    try {
      const [healthData, rulesData, historyData] = await Promise.all([
        api("/api/health"),
        api("/api/rules"),
        api("/api/history"),
      ]);
      setHealth(healthData);
      setRules(rulesData.rules);
      setDraftRules(rulesData.rules);
      setSelected((current) => current.size ? current : new Set(rulesData.rules.slice(0, 3).map((rule) => rule.id)));
      setHistory(historyData.runs);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadLabels() {
    setLoading("labels");
    setError("");
    try {
      const data = await api("/api/labels");
      setLabels(data.labels);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  useEffect(() => {
    if (view === "labels" && labels.length === 0) loadLabels();
  }, [view]);

  async function preview() {
    setLoading("plan");
    setError("");
    try {
      setPlan(await api("/api/plan", {
        method: "POST",
        body: JSON.stringify({ rule_ids: [...selected], limit, samples }),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function applyRules() {
    setLoading("apply");
    setError("");
    try {
      const data = await api("/api/apply", {
        method: "POST",
        body: JSON.stringify({ rule_ids: [...selected], limit, confirmation: confirm?.text }),
      });
      setConfirm(null);
      setPlan(null);
      setHistory((await api("/api/history")).runs);
      alert(`Applied ${data.applied.reduce((sum, item) => sum + item.count, 0)} messages.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function saveRules() {
    setLoading("save");
    setError("");
    try {
      const data = await api("/api/rules", {
        method: "PUT",
        body: JSON.stringify({ rules: draftRules }),
      });
      setRules(data.rules);
      setDraftRules(data.rules);
      setSelected(new Set(data.rules.slice(0, 3).map((rule) => rule.id)));
      setPlan(null);
      setView("run");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function loadLabelSample(label) {
    setLoading(`sample-${label.id}`);
    setError("");
    try {
      const data = await api(`/api/labels/${encodeURIComponent(label.id)}/sample?limit=8`);
      setLabelSamples((current) => ({ ...current, [label.id]: data.samples }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function trashLabel(label) {
    setLoading("trash-label");
    setError("");
    try {
      const data = await api("/api/labels/trash", {
        method: "POST",
        body: JSON.stringify({
          label_id: label.id,
          label_name: label.name,
          limit,
          confirmation: confirm?.text,
        }),
      });
      setConfirm(null);
      await loadLabels();
      setHistory((await api("/api/history")).runs);
      alert(`Moved ${data.trashed} messages to Trash.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function scanUnsubscribe() {
    setLoading("unsubscribe");
    setError("");
    try {
      const data = await api("/api/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ query: unsubscribeQuery, limit }),
      });
      setUnsubscribeCandidates(data.candidates);
      setUnsubscribeSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  function toggleRule(id) {
    setSelected((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleUnsubscribeCandidate(id) {
    setUnsubscribeSelected((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const selectedRules = useMemo(() => rules.filter((rule) => selected.has(rule.id)), [rules, selected]);
  const totalPlanned = plan?.results.reduce((sum, item) => sum + item.count, 0) ?? 0;

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand">
          <Inbox size={24} />
          <div>
            <h1>Gmail Cleanup</h1>
            <p>Local mailbox control</p>
          </div>
        </div>
        <nav>
          {views.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={view === item.id ? "nav-active" : ""} onClick={() => setView(item.id)}>
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-status">
          <Status label="Credentials" ok={health?.credentials} />
          <Status label="Token" ok={health?.token} />
          <Status label="Rules" ok={health?.rules} />
        </div>
      </aside>

      <section className="content">
        <header className="page-header">
          <div>
            <h2>{views.find((item) => item.id === view)?.label}</h2>
            <p>{pageSubtitle(view)}</p>
          </div>
          <button className="icon-button" onClick={refreshAll} title="Refresh">
            <RefreshCw size={18} />
          </button>
        </header>

        {error && <div className="error">{error}</div>}

        {view === "run" && (
          <RunView
            rules={rules}
            selected={selected}
            toggleRule={toggleRule}
            limit={limit}
            setLimit={setLimit}
            samples={samples}
            setSamples={setSamples}
            loading={loading}
            preview={preview}
            plan={plan}
            totalPlanned={totalPlanned}
            selectedRules={selectedRules}
            openConfirm={() => setConfirm({ mode: "apply", text: "" })}
          />
        )}

        {view === "rules" && (
          <RuleEditor rules={draftRules} setRules={setDraftRules} saveRules={saveRules} loading={loading} />
        )}

        {view === "labels" && (
          <LabelsView
            labels={labels}
            loadLabels={loadLabels}
            loading={loading}
            filter={labelFilter}
            setFilter={setLabelFilter}
            samples={labelSamples}
            loadSample={loadLabelSample}
            activeLabelId={confirm?.label?.id}
            openTrash={(label) => setConfirm({ mode: "trash-label", label, text: "" })}
          />
        )}

        {view === "unsubscribe" && (
          <UnsubscribeView
            query={unsubscribeQuery}
            setQuery={setUnsubscribeQuery}
            limit={limit}
            setLimit={setLimit}
            loading={loading}
            scan={scanUnsubscribe}
            candidates={unsubscribeCandidates}
            selected={unsubscribeSelected}
            toggle={toggleUnsubscribeCandidate}
          />
        )}

        {view === "history" && <HistoryView history={history} />}
      </section>

      {confirm && (
        <ConfirmModal
          confirm={confirm}
          setConfirm={setConfirm}
          limit={limit}
          selectedCount={selected.size}
          loading={loading}
          onApply={applyRules}
          onTrashLabel={trashLabel}
        />
      )}
    </main>
  );
}

function pageSubtitle(view) {
  if (view === "run") return "Select rules, preview matched messages, then apply a limited batch.";
  if (view === "rules") return "Create address-domain rules, add attachment filters, and choose actions.";
  if (view === "labels") return "Browse Gmail labels, inspect samples, and move label mail to Trash.";
  if (view === "unsubscribe") return "Find senders with standard unsubscribe headers and open their unsubscribe flows.";
  return "Review local apply and trash operations.";
}

function RunView(props) {
  const {
    rules,
    selected,
    toggleRule,
    limit,
    setLimit,
    samples,
    setSamples,
    loading,
    preview,
    plan,
    totalPlanned,
    selectedRules,
    openConfirm,
  } = props;

  return (
    <div className="run-layout">
      <section className="panel rule-picker">
        <div className="panel-heading">
          <div>
            <h3>Selectable Rules</h3>
            <p>Only checked rules can run.</p>
          </div>
        </div>
        <div className="controls">
          <label>Limit<input type="number" min="1" max="500" value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
          <label>Samples<input type="number" min="0" max="20" value={samples} onChange={(e) => setSamples(Number(e.target.value))} /></label>
        </div>
        <div className="rule-list">
          {rules.map((rule) => (
            <label className="rule-row" key={rule.id}>
              <input type="checkbox" checked={selected.has(rule.id)} onChange={() => toggleRule(rule.id)} />
              <span>
                <strong>{rule.name}</strong>
                <small>{rule.query}</small>
                <ActionList actions={rule.actions} />
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="panel main-panel">
        <div className="action-bar">
          <button onClick={preview} disabled={!selected.size || loading} className="primary">
            {loading === "plan" ? <Loader2 className="spin" size={18} /> : <Eye size={18} />}
            Preview selected
          </button>
          <button onClick={openConfirm} disabled={!selected.size || loading || !plan} className="danger">
            <Play size={18} />
            Apply confirmed
          </button>
        </div>
        <div className="summary-strip">
          <Metric label="Planned messages" value={totalPlanned} />
          <Metric label="Active rules" value={selectedRules.length} />
          <Metric label="Batch limit" value={limit} />
        </div>
        <PlanResults plan={plan} />
      </section>
    </div>
  );
}

function PlanResults({ plan }) {
  if (!plan) {
    return (
      <div className="empty-state">
        <Search size={32} />
        <p>Select rules and preview matches before applying changes.</p>
      </div>
    );
  }

  return (
    <div className="preview-area">
      {plan.results.map((result) => (
        <article className="result-card" key={result.id}>
          <header>
            <div>
              <h3>{result.name}</h3>
              <p>{result.query}</p>
            </div>
            <strong>{result.count}{result.limitReached ? "+" : ""}</strong>
          </header>
          <ActionList actions={result.actions} />
          <SampleList samples={result.samples} />
        </article>
      ))}
    </div>
  );
}

function RuleEditor({ rules, setRules, saveRules, loading }) {
  const [openRules, setOpenRules] = useState(new Set([0]));

  function updateRule(index, patch) {
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  }

  function updateAction(ruleIndex, actionIndex, patch) {
    setRules((current) => current.map((rule, i) => {
      if (i !== ruleIndex) return rule;
      return {
        ...rule,
        actions: rule.actions.map((action, j) => (j === actionIndex ? { ...action, ...patch } : action)),
      };
    }));
  }

  function toggleAttachment(index) {
    const query = rules[index].query;
    const next = query.includes("has:attachment")
      ? query.replace(/\s*has:attachment/g, "").trim()
      : `${query} has:attachment`;
    updateRule(index, { query: next });
  }

  function addDomainRule() {
    setRules((current) => [...current, {
      id: `draft-${Date.now()}`,
      name: "label company domain",
      query: "(from:company.com OR to:company.com OR cc:company.com)",
      actions: [{ type: "label", value: "Company/Company Name" }],
    }]);
    setOpenRules(new Set([rules.length]));
  }

  function addRule() {
    setRules((current) => [...current, {
      id: `draft-${Date.now()}`,
      name: "new rule",
      query: "from:example.com",
      actions: [{ type: "label", value: "New Label" }],
    }]);
    setOpenRules(new Set([rules.length]));
  }

  function duplicateRule(index) {
    setRules((current) => {
      const copy = { ...current[index], id: `draft-${Date.now()}`, name: `${current[index].name} copy` };
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
    });
  }

  function removeRule(index) {
    setRules((current) => current.filter((_, i) => i !== index));
    setOpenRules(new Set());
  }

  function toggleOpen(index) {
    setOpenRules((current) => {
      const next = new Set(current);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }

  function actionMeta(action) {
    const Icon = actionIcons[action.type] || Tag;
    const label = action.type === "label" ? action.value || "Label" : action.type.replace("_", " ");
    return { Icon, label };
  }

  return (
    <section className="panel config-panel">
      <div className="config-toolbar">
        <button onClick={addDomainRule}><Plus size={18} />Company domain rule</button>
        <button onClick={addRule}><Plus size={18} />Blank rule</button>
        <button className="primary" onClick={saveRules} disabled={loading === "save"}>
          {loading === "save" ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
          Save rules
        </button>
      </div>

      <div className="rule-editor-list">
        {rules.map((rule, index) => (
          <div className={`rule-editor ${openRules.has(index) ? "rule-editor-open" : ""}`} key={`${rule.id}-${index}`}>
            <div className="rule-card-summary">
              <button className="expand-button" onClick={() => toggleOpen(index)} title={openRules.has(index) ? "Collapse" : "Expand"}>
                {openRules.has(index) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </button>
              <div className="rule-title-block">
                <strong>{rule.name || "Untitled rule"}</strong>
                <small>{rule.query || "No query configured"}</small>
              </div>
              <div className="rule-badges">
                {rule.query.includes("has:attachment") && <span className="mini-badge">Attachments</span>}
                {rule.actions.slice(0, 3).map((action, actionIndex) => {
                  const { Icon, label } = actionMeta(action);
                  return <span className="mini-badge" key={`${action.type}-${actionIndex}`}><Icon size={13} />{label}</span>;
                })}
              </div>
              <div className="rule-card-actions">
                <button className="icon-button" title="Duplicate rule" onClick={() => duplicateRule(index)}><Copy size={16} /></button>
                <button className="icon-button danger-icon" title="Delete rule" onClick={() => removeRule(index)}><Trash2 size={16} /></button>
              </div>
            </div>

            {openRules.has(index) && (
              <div className="rule-card-body">
                <div className="editor-grid">
                  <label>Rule name<input value={rule.name} onChange={(e) => updateRule(index, { name: e.target.value })} /></label>
                  <label>Gmail search query<textarea value={rule.query} onChange={(e) => updateRule(index, { query: e.target.value })} /></label>
                </div>

                <div className="rule-options-grid">
                  <label className="toggle-card">
                    <input type="checkbox" checked={rule.query.includes("has:attachment")} onChange={() => toggleAttachment(index)} />
                    <span>
                      <strong>Attachments only</strong>
                      <small>Adds `has:attachment` to this Gmail search.</small>
                    </span>
                  </label>
                  <div className="query-pattern">
                    <span>Company domain pattern</span>
                    <code>(from:company.com OR to:company.com OR cc:company.com)</code>
                  </div>
                </div>

                <div className="section-label">Actions</div>
                <div className="action-editor-list">
                  {rule.actions.map((action, actionIndex) => {
                    const { Icon } = actionMeta(action);
                    return (
                      <div className="action-editor" key={actionIndex}>
                        <div className="action-type">
                          <Icon size={16} />
                          <select value={action.type} onChange={(e) => updateAction(index, actionIndex, { type: e.target.value })}>
                            <option value="label">Label</option>
                            <option value="archive">Archive</option>
                            <option value="mark_read">Mark read</option>
                            <option value="trash">Trash</option>
                          </select>
                        </div>
                        <input disabled={action.type !== "label"} value={action.value} placeholder="Label name" onChange={(e) => updateAction(index, actionIndex, { value: e.target.value })} />
                        <button className="icon-button danger-icon" title="Remove action" onClick={() => updateRule(index, { actions: rule.actions.filter((_, i) => i !== actionIndex) })}><Trash2 size={16} /></button>
                      </div>
                    );
                  })}
                </div>
                <div className="editor-actions">
                  <button onClick={() => updateRule(index, { actions: [...rule.actions, { type: "label", value: "" }] })}><Plus size={16} />Add action</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function LabelsView({ labels, loadLabels, loading, filter, setFilter, samples, loadSample, activeLabelId, openTrash }) {
  const activeLoadingId = loading.startsWith("sample-") ? loading.replace("sample-", "") : "";
  const visible = labels
    .filter((label) => label.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((left, right) => {
      const leftActive = left.id === activeLabelId || left.id === activeLoadingId || Boolean(samples[left.id]?.length);
      const rightActive = right.id === activeLabelId || right.id === activeLoadingId || Boolean(samples[right.id]?.length);
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  return (
    <section className="panel labels-panel">
      <div className="labels-toolbar">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search labels" />
        <button onClick={loadLabels} disabled={loading === "labels"}>
          {loading === "labels" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          Load labels
        </button>
      </div>
      <div className="label-list">
        {visible.map((label) => (
          <article
            className={`label-card ${
              label.id === activeLabelId || label.id === activeLoadingId ? "label-card-active" : ""
            } ${samples[label.id]?.length ? "label-card-sampled" : ""}`}
            key={label.id}
          >
            <header>
              <div>
                <h3>{label.name}</h3>
                <p>{label.type} label</p>
              </div>
              <div className="label-counts">
                <strong>{label.messagesTotal ?? 0}</strong>
                <span>{label.messagesUnread ?? 0} unread</span>
              </div>
            </header>
            <div className="label-actions">
              <button onClick={() => loadSample(label)} disabled={loading === `sample-${label.id}`}>
                {loading === `sample-${label.id}` ? <Loader2 className="spin" size={16} /> : <Eye size={16} />}
                Samples
              </button>
              <button className="danger" onClick={() => openTrash(label)} disabled={loading === "trash-label"}>
                <Trash2 size={16} />
                Move to Trash
              </button>
            </div>
            <SampleList samples={samples[label.id] || []} />
          </article>
        ))}
      </div>
    </section>
  );
}

function UnsubscribeView({ query, setQuery, limit, setLimit, loading, scan, candidates, selected, toggle }) {
  const selectedCandidates = candidates.filter((item) => selected.has(item.id));

  function openSelected() {
    selectedCandidates.forEach((item) => {
      const target = item.targets.find((value) => value.startsWith("http")) || item.targets[0];
      if (target) window.open(target, "_blank", "noopener,noreferrer");
    });
  }

  return (
    <section className="panel unsubscribe-panel">
      <div className="unsubscribe-toolbar">
        <label>
          Gmail search
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          Scan limit
          <input type="number" min="1" max="500" value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </label>
        <button className="primary" onClick={scan} disabled={loading === "unsubscribe"}>
          {loading === "unsubscribe" ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
          Scan
        </button>
        <button onClick={openSelected} disabled={!selected.size}>
          <MousePointerClick size={18} />
          Open selected
        </button>
      </div>

      <div className="unsubscribe-list">
        {candidates.length === 0 && (
          <div className="empty-state">
            <MousePointerClick size={32} />
            <p>Scan messages to find senders that publish unsubscribe links.</p>
          </div>
        )}
        {candidates.map((item) => (
          <article className={`unsubscribe-card ${selected.has(item.id) ? "unsubscribe-card-active" : ""}`} key={item.id}>
            <label className="unsubscribe-card-head">
              <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
              <span>
                <strong>{item.from}</strong>
                <small>{item.count} message(s) found {item.oneClick ? "with one-click support" : ""}</small>
              </span>
            </label>
            <div className="unsubscribe-targets">
              {item.targets.map((target) => (
                <a key={target} href={target} target="_blank" rel="noreferrer">{target}</a>
              ))}
            </div>
            <SampleList samples={item.samples.map((sample, index) => ({ ...sample, id: `${item.id}-${index}`, from: item.from }))} />
          </article>
        ))}
      </div>
    </section>
  );
}

function HistoryView({ history }) {
  return (
    <section className="panel history-panel-full">
      {history.length === 0 && <p className="muted">No apply runs yet.</p>}
      {history.map((run) => (
        <div className="history-item" key={run.timestamp}>
          <strong>{new Date(run.timestamp).toLocaleString()}</strong>
          <small>Limit {run.limit}</small>
          {run.rules?.map((rule) => <span key={rule.id}>{rule.name}: {rule.count}</span>)}
          {run.labelTrash && <span>Moved label to Trash: {run.labelTrash.name}: {run.labelTrash.count}</span>}
        </div>
      ))}
    </section>
  );
}

function ConfirmModal({ confirm, setConfirm, limit, selectedCount, loading, onApply, onTrashLabel }) {
  const isTrashLabel = confirm.mode === "trash-label";
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>{isTrashLabel ? "Move Label Mail to Trash" : "Confirm Apply"}</h2>
        <p>
          {isTrashLabel
            ? `This moves up to ${limit} messages from "${confirm.label.name}" to Gmail Trash. Type TRASH to continue.`
            : `This runs ${selectedCount} selected rule(s), up to ${limit} messages per rule. Type APPLY to continue.`}
        </p>
        <input autoFocus value={confirm.text} onChange={(e) => setConfirm({ ...confirm, text: e.target.value })} placeholder={isTrashLabel ? "TRASH" : "APPLY"} />
        <div className="modal-actions">
          <button onClick={() => setConfirm(null)}>Cancel</button>
          <button className="danger" disabled={loading === "apply" || loading === "trash-label"} onClick={() => isTrashLabel ? onTrashLabel(confirm.label) : onApply()}>
            {loading ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function Status({ label, ok }) {
  return (
    <div className="status-pill">
      <span>{label}</span>
      <strong className={ok ? "ok" : "bad"}>{ok ? "Ready" : "Missing"}</strong>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActionList({ actions }) {
  return (
    <div className="actions">
      {actions.map((action, index) => {
        const Icon = actionIcons[action.type] || Tag;
        return (
          <span className={`action action-${action.type}`} key={`${action.type}-${index}`}>
            <Icon size={14} />
            {action.value || action.type.replace("_", " ")}
          </span>
        );
      })}
    </div>
  );
}

function SampleList({ samples }) {
  if (!samples?.length) return null;
  return (
    <div className="sample-list">
      {samples.map((sample) => (
        <div className="sample-row" key={sample.id}>
          <span>{sample.from}</span>
          <strong>{sample.subject || "(no subject)"}</strong>
          <small>{sample.date}</small>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
