import {
  normalizeSnapshot,
  type AgentEndpointSnapshot,
  type AgentGuardCommand,
  type AgentGuardSnapshot,
  type IncidentSummary,
  type PolicyV1,
} from '@itharbors/agent-guard-contracts';

type PanelContext = {
  message: { request(plugin: string, name: string, ...args: unknown[]): Promise<unknown> };
};

const PLUGIN = '@itharbors/agent-guard-center';
const POLL_MS = 2_000;
let context: PanelContext | null = null;
let root: HTMLElement | null = null;
let timer: number | null = null;
let mounted = false;
let version = 0;
let requestGeneration = 0;
let refreshPromise: Promise<void> | null = null;
let mutation: Promise<void> | null = null;
let signature = '';

const panel = {
  async mount(nextContext: PanelContext) {
    version += 1;
    context = nextContext;
    root = document.getElementById('guard-root');
    if (!root) throw new Error('Agent Guard root is missing');
    mounted = true;
    signature = '';
    renderState('Opening the local traffic watch…', 'loading');
    await refresh();
    if (mounted) timer = window.setInterval(() => { void refresh(); }, POLL_MS);
  },
  unmount() {
    mounted = false;
    version += 1;
    requestGeneration += 1;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    refreshPromise = null;
    mutation = null;
    context = null;
    root = null;
  },
};

export default panel;

function refresh(): Promise<void> {
  if (!mounted || !context || mutation) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  const activeContext = context;
  const activeVersion = version;
  const generation = ++requestGeneration;
  let operation: Promise<void>;
  operation = (async () => {
    try {
      const snapshot = normalizeSnapshot(await activeContext.message.request(PLUGIN, 'getSnapshot'));
      if (!isCurrent(activeVersion, generation)) return;
      const nextSignature = JSON.stringify(snapshot);
      if (nextSignature !== signature) {
        signature = nextSignature;
        renderSnapshot(snapshot);
      }
    } catch (error) {
      if (isCurrent(activeVersion, generation)) {
        renderState(error instanceof Error ? error.message : 'Traffic monitor unavailable', 'unavailable');
      }
    } finally {
      if (refreshPromise === operation) refreshPromise = null;
    }
  })();
  refreshPromise = operation;
  return operation;
}

function isCurrent(activeVersion: number, generation: number) {
  return mounted && version === activeVersion && requestGeneration === generation;
}

function runCommand(command: AgentGuardCommand): void {
  runMutation('executeCommand', command);
}

function runMutation(method: 'executeCommand' | 'updatePolicy', input: AgentGuardCommand | PolicyV1): void {
  if (!context || mutation) return;
  const activeContext = context;
  mutation = (async () => {
    setButtonsDisabled(true);
    try {
      await activeContext.message.request(PLUGIN, method, input);
      signature = '';
      mutation = null;
      await refresh();
    } catch (error) {
      renderState(error instanceof Error ? error.message : 'Command failed', 'unavailable');
    } finally {
      mutation = null;
      setButtonsDisabled(false);
    }
  })();
}

function renderSnapshot(snapshot: AgentGuardSnapshot): void {
  if (!root) return;
  const workspace = document.createElement('div');
  workspace.className = 'guard-workspace';
  workspace.append(createHeader(snapshot), createTrafficSection(snapshot.endpoints));

  const lower = document.createElement('div');
  lower.className = 'lower-deck';
  lower.append(createIncidentLedger(snapshot.incidents), createPolicyPanel());
  workspace.append(lower, createPrivacyNote());

  const status = document.createElement('p');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = `${snapshot.endpoints.length} endpoints observed; protection ${snapshot.state}`;
  workspace.append(status);
  root.replaceChildren(workspace);
}

function createHeader(snapshot: AgentGuardSnapshot): HTMLElement {
  const header = document.createElement('header');
  header.className = 'protection-header';
  const identity = document.createElement('div');
  identity.className = 'identity';
  identity.append(textElement('span', 'eyebrow', 'Zero-config watch / local machine'));
  const title = textElement('h1', '', 'Local agent traffic');
  const description = textElement(
    'p', 'lede', 'Cumulative connection bytes and task activity for known Agent processes.',
  );
  identity.append(title, description);

  const seal = document.createElement('div');
  seal.className = `protection-seal state-${snapshot.state}`;
  seal.dataset.state = snapshot.state;
  seal.append(
    textElement('span', 'seal-label', snapshot.state === 'tripped' ? 'Flow stopped' : 'Protection'),
    textElement('strong', '', stateLabel(snapshot.state)),
    textElement('span', 'seal-detail', snapshot.collector.incomplete ? 'Collector gap — warning only' : `Epoch ${snapshot.collector.epoch}`),
  );
  header.append(identity, seal);
  return header;
}

function createTrafficSection(endpoints: AgentEndpointSnapshot[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'traffic-deck';
  section.setAttribute('aria-labelledby', 'traffic-title');
  const heading = textElement('div', 'section-heading', '');
  const title = textElement('h2', '', 'Observed routes');
  title.id = 'traffic-title';
  heading.append(title, textElement('span', 'section-note', '2-second cumulative counters · 60-second rates'));
  section.append(heading);
  if (endpoints.length === 0) {
    section.append(textElement('p', 'empty-route', 'No Claude or Codex model endpoints are active right now. Watching continues in the background.'));
    return section;
  }
  const routes = document.createElement('div');
  routes.className = 'route-list';
  for (const endpoint of endpoints) routes.append(createRoute(endpoint));
  section.append(routes);
  return section;
}

function createRoute(endpoint: AgentEndpointSnapshot): HTMLElement {
  const article = document.createElement('article');
  article.className = 'traffic-route';
  article.dataset.agent = endpoint.agent;
  const start = document.createElement('div');
  start.className = 'route-origin';
  start.append(
    textElement('span', 'agent-mark', endpoint.agent === 'claude' ? 'CL' : 'CX'),
    textElement('strong', '', endpoint.agent === 'claude' ? 'Claude' : 'Codex'),
    textElement('span', 'provider', endpoint.provider),
  );
  const lane = document.createElement('div');
  lane.className = 'flow-lane';
  lane.setAttribute('aria-hidden', 'true');
  lane.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  const destination = document.createElement('div');
  destination.className = 'route-destination';
  destination.append(textElement('code', '', endpoint.hostname));
  const confidence = textElement('span', `confidence confidence-${endpoint.confidence}`, confidenceLabel(endpoint.confidence));
  confidence.dataset.confidence = endpoint.confidence;
  destination.append(confidence);

  const metrics = document.createElement('dl');
  metrics.className = 'route-metrics';
  metrics.append(
    metric('Outbound', formatRate(endpoint.bytesOutPerMinute), 'bytes-out'),
    metric('Inbound', formatRate(endpoint.bytesInPerMinute), 'bytes-in'),
    metric('Connections', String(endpoint.connections), 'connections'),
    metric('Active tasks', String(endpoint.activeTasks), 'active-tasks'),
  );
  article.append(start, lane, destination, metrics);
  return article;
}

function createIncidentLedger(incidents: IncidentSummary[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'incident-ledger';
  const heading = textElement('div', 'section-heading', '');
  heading.append(textElement('h2', '', 'Event ledger'), textElement('span', 'section-note', `${incidents.length} retained in this view`));
  section.append(heading);
  if (incidents.length === 0) {
    section.append(textElement('p', 'ledger-empty', 'No abnormal Agent traffic has been recorded.'));
    return section;
  }
  for (const incident of [...incidents].reverse()) section.append(createIncident(incident));
  return section;
}

function createIncident(incident: IncidentSummary): HTMLElement {
  const article = document.createElement('article');
  article.className = `incident-row incident-${incident.state}`;
  article.dataset.incidentId = incident.id;
  const marker = textElement('span', 'incident-marker', incident.state === 'tripped' ? 'STOP' : 'WATCH');
  const body = document.createElement('div');
  body.className = 'incident-body';
  body.append(
    textElement('strong', '', incident.ruleId),
    textElement('p', '', incident.summary),
    textElement('span', 'incident-meta', `${incident.agent} · ${incident.hostname} · ${confidenceLabel(incident.confidence)}`),
  );
  const actions = document.createElement('div');
  actions.className = 'incident-actions';
  if (incident.state === 'tripped') {
    actions.append(button('Resume task', 'resume', () => runCommand({ type: 'resume', incidentId: incident.id })));
    actions.append(button('End task', 'terminate', () => runCommand({ type: 'terminate', incidentId: incident.id })));
  }
  actions.append(button('Ignore 15 min', 'ignore', () => runCommand({
    type: 'ignore', incidentId: incident.id, durationMinutes: 15,
  })));
  article.append(marker, body, actions);
  return article;
}

function createPolicyPanel(): HTMLElement {
  const aside = document.createElement('aside');
  aside.className = 'policy-panel';
  aside.append(
    textElement('span', 'eyebrow', 'Policy v1'),
    textElement('h2', '', 'Two signals before a stop'),
    textElement('p', '', 'Byte spikes warn first. Automatic pauses require confirmed model traffic plus repeated task or session growth.'),
  );
  const form = document.createElement('form');
  form.className = 'policy-form';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(form);
    runMutation('updatePolicy', policyWithThresholds(
      Number(values.get('warning-outbound')),
      Number(values.get('trip-outbound')),
    ));
  });
  form.append(
    numberField('Warn at', 'warning-outbound', DEFAULT_POLICY.fixedWarning.outboundMiB, 'MiB / 10 min'),
    numberField('Pause at', 'trip-outbound', DEFAULT_POLICY.fixedTrip.outboundMiB, 'MiB / 10 min'),
    button('Save policy', 'save-policy', () => form.requestSubmit()),
  );
  aside.append(form);
  return aside;
}

function numberField(label: string, name: string, value: number, unit: string): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'policy-field';
  wrapper.append(textElement('span', '', label));
  const line = document.createElement('span');
  line.className = 'policy-input';
  const input = document.createElement('input');
  input.type = 'number';
  input.name = name;
  input.min = '1';
  input.step = '1';
  input.required = true;
  input.value = String(value);
  line.append(input, textElement('small', '', unit));
  wrapper.append(line);
  return wrapper;
}

function policyWithThresholds(warningOutboundMiB: number, tripOutboundMiB: number): PolicyV1 {
  return {
    ...DEFAULT_POLICY,
    fixedWarning: { ...DEFAULT_POLICY.fixedWarning, outboundMiB: warningOutboundMiB },
    fixedTrip: { ...DEFAULT_POLICY.fixedTrip, outboundMiB: tripOutboundMiB },
  };
}

function createPrivacyNote(): HTMLElement {
  const note = document.createElement('footer');
  note.className = 'privacy-note';
  note.append(
    textElement('span', 'privacy-lock', 'LOCAL / METADATA ONLY'),
    textElement('p', '', 'Prompts, responses, credentials, and exact request totals are never collected.'),
  );
  return note;
}

function renderState(message: string, state: string): void {
  if (!root) return;
  const container = document.createElement('section');
  container.className = 'panel-state';
  container.dataset.state = state;
  container.setAttribute('role', state === 'unavailable' ? 'alert' : 'status');
  container.append(textElement('span', 'eyebrow', 'Agent Guard'), textElement('h1', '', message));
  if (state === 'unavailable') container.append(button('Try again', 'retry', () => { void refresh(); }));
  root.replaceChildren(container);
}

function metric(label: string, value: string, name?: string): HTMLElement {
  const wrapper = document.createElement('div');
  const term = textElement('dt', '', label);
  const description = textElement('dd', '', value);
  if (name) description.dataset.metric = name;
  wrapper.append(term, description);
  return wrapper;
}

function button(label: string, action: string, handler: () => void): HTMLButtonElement {
  const value = document.createElement('button');
  value.type = 'button';
  value.dataset.action = action;
  value.textContent = label;
  value.addEventListener('click', handler);
  return value;
}

function setButtonsDisabled(disabled: boolean): void {
  root?.querySelectorAll<HTMLButtonElement>('button').forEach((value) => { value.disabled = disabled; });
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function formatRate(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB/min`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB/min`;
  return `${bytes} B/min`;
}

function confidenceLabel(value: AgentEndpointSnapshot['confidence']): string {
  return value === 'confirmed' ? 'Confirmed' : value === 'probable' ? 'Probable' : 'Unknown';
}

function stateLabel(value: AgentGuardSnapshot['state']): string {
  return ({
    learning: 'Learning', normal: 'On watch', warning: 'Warning', tripped: 'Tripped',
    cooldown: 'Cooling down', degraded: 'Degraded',
  } as const)[value];
}

const DEFAULT_POLICY: PolicyV1 = {
  schemaVersion: 1,
  evaluationWindowSeconds: 60,
  consecutiveWindows: 3,
  trafficWindowMinutes: 10,
  learningHours: 24,
  dynamicWarning: {
    medianMultiplier: 5,
    madMultiplier: 6,
    minOutboundMiBPerMinute: 8,
    corroborators: { sessionsPerMinute: 6, tasksPerMinute: 8, connectionsPerMinute: 20 },
  },
  fixedWarning: { outboundMiB: 128, sessionsOrTasks: 20 },
  fixedTrip: { outboundMiB: 256, sessionsOrTasks: 30, minimumConfidence: 'confirmed' },
  structuralTrip: {
    recursiveDepth: 4,
    recursiveTasks: 8,
    recursiveWindowSeconds: 120,
    burstTasks: 20,
    burstActiveTasks: 8,
    burstWindowSeconds: 60,
  },
};
