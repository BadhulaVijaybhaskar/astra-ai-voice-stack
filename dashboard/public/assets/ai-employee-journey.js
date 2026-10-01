/**
 * Astra Voice. Guided AI Employee Setup / Demo Journey (add-on UI).
 * Feature flag: ENABLE_AI_EMPLOYEE_JOURNEY (exposed via /api/me features).
 * Route: #/ai-employee-setup
 *
 * Relies on shared helpers from app.js: el, esc, api, toast, State, initials.
 * No em dashes anywhere. Commas and periods only.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'astra_ai_employee_journey_v1';
  const STEPS = [
    { id: 'employee', label: 'Employee', title: 'Your AI employee' },
    { id: 'knowledge', label: 'Knowledge', title: 'Teach the job' },
    { id: 'language', label: 'Language', title: 'Voice & language' },
    { id: 'routing', label: 'Routing', title: 'Connect customers' },
    { id: 'call', label: 'Call', title: 'Live conversation' },
    { id: 'outcome', label: 'Outcome', title: 'Structured result' },
    { id: 'next', label: 'Next', title: 'Next action' },
  ];

  const JourneyState = {
    payload: null,
    step: 'employee',
    mode: 'live',
    dirtyPrompt: null,
    talk: null,
  };

  function stepIndex(id) {
    const i = STEPS.findIndex((s) => s.id === id);
    return i >= 0 ? i : 0;
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function saveLocal(patch) {
    const next = Object.assign(loadLocal(), patch || {}, { updatedAt: Date.now() });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (_) {}
    return next;
  }

  function icon(name) {
    const paths = {
      employee: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/>',
      knowledge: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M8 7h8M8 11h6"/>',
      language: '<path d="M5 7h8M9 7c0 6-4 10-4 10M13 7c0 4 2 8 6 10"/><path d="M14 17l2 4 2-4"/>',
      routing: '<path d="M5 3.5h3l1.5 4.5-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5z"/>',
      call: '<path d="M4 12h2l1.5-4 2 8 2-10 2 8 1.5-4H18"/>',
      outcome: '<path d="M7 3h10v18H7z"/><path d="M10 7h4M10 11h4M10 15h2"/>',
      next: '<path d="M4 19h16"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-6"/>',
    };
    return '<svg viewBox="0 0 24 24">' + (paths[name] || paths.employee) + '</svg>';
  }

  function demoBadge(show) {
    if (!show) return null;
    return el('span', { class: 'journey-demo-badge' }, 'Demo preview');
  }

  async function fetchJourney(opts) {
    const q = new URLSearchParams();
    if (opts && opts.step) q.set('step', opts.step);
    if (opts && opts.mode) q.set('mode', opts.mode);
    const qs = q.toString() ? ('?' + q.toString()) : '';
    return api('/api/ai-employee-journey' + qs);
  }

  async function saveJourney(body) {
    return api('/api/ai-employee-journey', { method: 'PUT', body: body || {} });
  }

  function stopTalk() {
    const t = JourneyState.talk;
    if (!t) return;
    try {
      if (t.ws && t.ws.readyState < 2) t.ws.close();
    } catch (_) {}
    try {
      if (t.pc) {
        t.pc.getSenders().forEach((s) => s.track && s.track.stop());
        t.pc.close();
      }
    } catch (_) {}
    try {
      if (t.stream) t.stream.getTracks().forEach((tr) => tr.stop());
    } catch (_) {}
    if (t.timer) clearInterval(t.timer);
    if (t.audio) t.audio.srcObject = null;
    JourneyState.talk = null;
  }

  function highlightText(text, highlights) {
    const raw = String(text || '');
    if (!Array.isArray(highlights) || !highlights.length) return raw;
    let out = esc(raw);
    highlights.forEach((h) => {
      const needle = String(h || '').trim();
      if (!needle) return;
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(re, (m) => '<mark>' + m + '</mark>');
    });
    return out;
  }

  /* ---- Step renderers ---- */

  function renderEmployee(data) {
    const e = data.employee || {};
    if (e.empty) {
      return el('div', { class: 'journey-card journey-empty' }, [
        el('p', {}, e.message || 'No employee found.'),
        el('a', { class: 'btn btn-primary', href: '#/employees?create=1' }, 'Create employee'),
      ]);
    }
    const name = e.name || 'Employee';
    const ready = e.readiness || {};
    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'journey-profile' }, [
          el('div', { class: 'journey-avatar' }, initials(name)),
          el('div', { class: 'meta' }, [
            el('strong', {}, name),
            el('div', { class: 'sub' }, [(e.role || 'Role'), ' · ', (e.team || 'Team')].join('')),
          ]),
          el('div', { class: 'journey-status' }, [
            el('span', { class: 'dot' }),
            e.status || '-',
          ]),
        ]),
        demoBadge(e.demoPreview),
      ]),
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'eyebrow' }, 'Job'),
        el('p', { class: 'sub' }, e.job || '-'),
      ]),
      el('div', { class: 'journey-checklist' }, [
        el('div', { class: 'journey-check' }, ready.instructionsReady ? 'Instructions ready' : 'Instructions needed'),
        el('div', { class: 'journey-check' }, ready.knowledgeAdded ? 'Knowledge added' : 'Knowledge needed'),
        el('div', { class: 'journey-check' }, ready.outcomeFieldsSet ? 'Outcome fields set' : 'Outcome fields needed'),
      ]),
    ]);
  }

  function renderKnowledge(data) {
    const k = data.knowledge || {};
    const prompt = JourneyState.dirtyPrompt != null ? JourneyState.dirtyPrompt : (k.systemPrompt || '');
    const ta = el('textarea', {
      class: 'journey-textarea',
      value: prompt,
      disabled: !!k.demoPreview,
      oninput: (ev) => { JourneyState.dirtyPrompt = ev.target.value; },
    });
    // value attr is unreliable for textarea in createElement path; set property.
    ta.value = prompt;

    const rules = (k.qualificationRules || []).map((rule, idx) => {
      const toggle = el('button', {
        class: 'journey-toggle' + (rule.enabled ? ' is-on' : ''),
        type: 'button',
        'aria-pressed': rule.enabled ? 'true' : 'false',
        onclick: async () => {
          if (k.demoPreview) return toast('Demo preview only. Switch to Live mode to edit.', 'info');
          const next = (k.qualificationRules || []).map((r, i) => (
            i === idx ? Object.assign({}, r, { enabled: !r.enabled }) : r
          ));
          try {
            await saveJourney({ qualificationRules: next, mode: 'live', step: 'knowledge' });
            toast('Qualification rules saved.', 'ok');
            await refresh();
          } catch (err) {
            toast(err.message || 'Could not save rules.', 'err');
          }
        },
      });
      return el('div', { class: 'journey-rule' }, [
        el('div', {}, [
          el('div', {}, rule.label || rule.id),
          rule.demoPreview ? demoBadge(true) : null,
        ]),
        toggle,
      ]);
    });

    const kbItems = (k.knowledge || []).length
      ? (k.knowledge || []).map((item) => el('div', { class: 'journey-kb-item' }, [
        el('div', {}, [
          el('div', { class: 'title' }, item.title || 'Knowledge'),
          el('div', { class: 'meta' }, item.meta || item.kind || ''),
          item.demoPreview ? demoBadge(true) : null,
        ]),
      ]))
      : [el('p', { class: 'muted' }, 'No knowledge attached yet. Add file, text, or URL from Training.')];

    const saveBtn = k.demoPreview ? null : el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      onclick: async () => {
        try {
          await saveJourney({
            mode: 'live',
            step: 'knowledge',
            instructions: JourneyState.dirtyPrompt != null ? JourneyState.dirtyPrompt : (k.systemPrompt || ''),
          });
          JourneyState.dirtyPrompt = null;
          toast('System prompt draft saved to employee instructions.', 'ok');
          await refresh();
        } catch (err) {
          toast(err.message || 'Could not save prompt.', 'err');
        }
      },
    }, 'Save prompt');

    const addRow = k.demoPreview ? null : el('div', { class: 'flex gap-2', style: 'flex-wrap:wrap' }, [
      el('a', { class: 'btn btn-ghost btn-sm', href: data.employeeId ? ('#/employees?id=' + encodeURIComponent(data.employeeId) + '&tab=training') : '#/knowledge' }, 'Add knowledge'),
    ]);

    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'flex items-center gap-2', style: 'justify-content:space-between;margin-bottom:8px' }, [
          el('h3', {}, 'System prompt'),
          saveBtn,
        ]),
        ta,
        k.demoPreview ? demoBadge(true) : null,
      ]),
      el('div', { class: 'journey-card' }, [
        el('h3', {}, 'Business knowledge'),
        el('div', { class: 'journey-kb-list', style: 'margin-top:10px' }, kbItems),
        addRow,
      ]),
      el('div', { class: 'journey-card' }, [
        el('h3', {}, 'Qualification rules'),
        el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:10px' }, rules.length ? rules : [
          el('p', { class: 'muted' }, 'No qualification rules yet. Outcome definitions on the employee appear here.'),
        ]),
      ]),
    ]);
  }

  function renderLanguage(data) {
    const L = data.language || {};
    const voice = L.voice || {};
    const options = (voice.options || [
      {
        id: 'current',
        name: (voice.current && (voice.current.speaker || voice.current.model)) || voice.title || 'Current voice',
        description: (voice.subtitle || 'Draft preview only'),
        selected: true,
      },
    ]).map((opt) => el('button', {
      class: 'journey-voice-opt' + (opt.selected ? ' is-selected' : ''),
      type: 'button',
      onclick: () => {
        if (opt.demoPreview || L.demoPreview) toast('Demo preview voice. Switch to Live to use catalog drafts.', 'info');
      },
    }, [
      el('strong', {}, opt.name),
      el('span', {}, opt.description || ''),
      opt.demoPreview ? demoBadge(true) : null,
    ]));

    const chips = (L.languages || []).map((lang) => el('button', {
      class: 'journey-chip' + (lang.selected ? ' is-selected' : ''),
      type: 'button',
      onclick: async () => {
        if (L.demoPreview || lang.demoPreview) {
          return toast('Demo preview language. Switch to Live mode to save.', 'info');
        }
        if (lang.status && lang.status !== 'Available' && !lang.live) {
          toast(lang.label + ' is "' + lang.status + '". Not labeled live.', 'info');
        }
        try {
          await saveJourney({
            mode: 'live',
            step: 'language',
            languageDraft: lang.code,
            language: lang.live ? lang.code : undefined,
          });
          toast(lang.live ? ('Language set to ' + lang.label) : ('Draft language ' + lang.label + ' saved.'), 'ok');
          await refresh();
        } catch (err) {
          toast(err.message || 'Could not save language.', 'err');
        }
      },
    }, [
      lang.label + (lang.demoPreview ? ' · Demo preview' : ''),
      el('span', { class: 'status' }, lang.status || ''),
    ]));

    const providerSel = el('select', { class: 'select' }, [
      el('option', { value: 'dograh' }, 'Dograh Managed'),
      el('option', { value: 'deepgram' }, 'Deepgram Aura'),
      el('option', { value: 'sarvam' }, 'Sarvam'),
      el('option', { value: 'rumik' }, 'Rumik'),
    ]);
    const speed = el('input', { type: 'range', min: '0.75', max: '1.25', step: '0.05', value: '1' });
    const previewBtn = el('button', {
      class: 'journey-play',
      type: 'button',
      'aria-label': 'Preview voice',
      onclick: async () => {
        try {
          const text = voice.previewText || 'Hi, this is Maya from Astra Voice. Is now a good time?';
          const provider = providerSel.value;
          const res = await fetch('/api/tts', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              provider: provider === 'dograh' ? 'rumik' : provider,
              model: provider === 'rumik' ? 'mulberry' : undefined,
            }),
          });
          if (!res.ok) throw new Error('Preview failed');
          const buf = await res.arrayBuffer();
          const blob = new Blob([buf], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.play().catch(() => {});
          toast('Playing draft preview. Production voice unchanged.', 'ok');
        } catch (err) {
          toast(err.message || 'Voice preview unavailable.', 'err');
        }
      },
    }, el('span', { html: '▶' }));

    const saveDraft = L.demoPreview ? null : el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      onclick: async () => {
        try {
          await api('/api/voice/draft-prefs', {
            method: 'PUT',
            body: {
              voice_mode: providerSel.value === 'dograh' ? 'dograh_managed' : 'byok',
              provider: providerSel.value,
              speed: Number(speed.value) || 1,
              apply_live: false,
            },
          });
          await saveJourney({
            mode: 'live',
            step: 'language',
            voiceDraft: {
              provider: providerSel.value,
              speed: Number(speed.value) || 1,
              apply_live: false,
            },
          });
          toast('Voice draft saved. Maya production voice was not changed.', 'ok');
        } catch (err) {
          toast(err.message || 'Could not save voice draft.', 'err');
        }
      },
    }, 'Save draft');

    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-card is-soft' }, [
        el('div', { class: 'eyebrow' }, 'Voice'),
        el('h3', {}, voice.title || 'Voice profile'),
        el('p', { class: 'sub' }, voice.subtitle || 'Preview + Save draft only.'),
        el('div', { class: 'journey-voice-options', style: 'margin:12px 0' }, options),
        el('div', { class: 'journey-select-row', style: 'margin-bottom:10px' }, [
          el('label', {}, ['Provider', providerSel]),
          el('label', {}, ['Speed', speed]),
        ]),
        el('div', { class: 'journey-preview-bar' }, [
          previewBtn,
          el('div', { class: 'sub', style: 'flex:1' }, '"' + (voice.previewText || 'Hi, this is Maya from Astra Voice.') + '"'),
          el('div', { class: 'journey-wave', 'aria-hidden': 'true' }),
          saveDraft,
        ]),
        L.demoPreview ? demoBadge(true) : el('p', { class: 'journey-note', style: 'margin-top:8px' }, 'Production TTS / Maya live voice is never auto-flipped from this screen.'),
      ]),
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'eyebrow' }, 'Language'),
        el('h3', {}, L.demoPreview ? 'Regional language ready' : 'Languages'),
        el('p', { class: 'sub' }, 'Statuses stay honest: Available, Ready for paid validation, Tested, Unavailable.'),
        el('div', { class: 'journey-lang-chips', style: 'margin-top:12px' }, chips),
        L.note ? el('p', { class: 'journey-note', style: 'margin-top:12px' }, L.note) : null,
      ]),
    ]);
  }

  function renderRouting(data) {
    const r = data.routing || {};
    const num = r.businessNumber || {};
    const hours = r.workingHours || {};
    const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const activeDays = new Set(hours.days || [1, 2, 3, 4, 5]);
    const days = dayLabels.map((label, idx) => el('div', {
      class: 'journey-day' + (activeDays.has(idx) ? ' is-on' : ''),
    }, label));

    const rules = (r.routing || []).map((rule) => el('div', { class: 'journey-rule' }, [
      el('div', {}, [
        el('strong', {}, rule.when || 'When'),
        el('div', { class: 'sub' }, '→ ' + (rule.then || '')),
        rule.demoPreview ? demoBadge(true) : null,
      ]),
    ]));

    const cal = r.calendar || {};
    const primary = cal.primary || {};
    const secondary = cal.secondary || {};

    const testBtn = el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      onclick: async () => {
        try {
          const out = await api('/api/ai-employee-journey/calendar/test');
          if (out.connected) toast('Cal.com connected · ' + (out.label || 'event'), 'ok');
          else toast(out.error || 'Cal.com not connected', 'info');
        } catch (err) {
          toast(err.message || 'Calendar test failed.', 'err');
        }
      },
    }, 'Test connection');

    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'eyebrow' }, 'Business number'),
        el('h3', {}, num.e164 || '-'),
        el('p', { class: 'sub' }, num.direction || ''),
        num.note ? el('p', { class: 'journey-note' }, num.note) : null,
        num.demoPreview ? demoBadge(true) : null,
      ]),
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'eyebrow' }, 'Routing'),
        el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:8px' },
          rules.length ? rules : [el('p', { class: 'muted' }, 'No routing rules yet. Configure Actions on the employee or assign a workflow.')]),
        r.workflowName ? el('p', { class: 'journey-note' }, 'Assigned workflow · ' + r.workflowName) : null,
      ]),
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'eyebrow' }, 'Working hours'),
        el('h3', {}, hours.label || 'Asia/Kolkata'),
        el('div', { class: 'journey-days', style: 'margin-top:10px' }, days),
        hours.demoPreview ? demoBadge(true) : null,
      ]),
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'eyebrow' }, 'Calendar'),
        el('div', { class: 'journey-field-grid' }, [
          el('div', { class: 'journey-card is-soft', style: 'padding:12px' }, [
            el('strong', {}, primary.label || 'Calendar'),
            el('p', { class: 'sub' }, primary.status || '-'),
            primary.eventTypeId ? el('p', { class: 'journey-note' }, 'Event ' + primary.eventTypeId) : null,
            primary.note ? el('p', { class: 'journey-note' }, primary.note) : null,
            primary.demoPreview ? demoBadge(true) : null,
          ]),
          el('div', { class: 'journey-card', style: 'padding:12px' }, [
            el('strong', {}, secondary.label || 'Second calendar'),
            el('p', { class: 'sub' }, secondary.status || 'Connect'),
            secondary.demoPreview ? demoBadge(true) : null,
          ]),
        ]),
        el('div', { class: 'flex gap-2', style: 'margin-top:10px;flex-wrap:wrap' }, [
          testBtn,
          el('a', { class: 'btn btn-ghost btn-sm', href: '#/integrations' }, 'Change provider'),
        ]),
      ]),
    ]);
  }

  function renderCall(data) {
    const c = data.call || {};
    const statusEl = el('span', {}, 'Ready');
    const timerEl = el('span', {}, c.timer || '00:00');
    const statusPill = el('div', { class: 'journey-pill' }, [el('span', {}, 'Status · '), statusEl]);
    const timerPill = el('div', { class: 'journey-pill is-dark' }, timerEl);
    const langPill = el('div', { class: 'journey-pill is-outline' }, c.language || (c.demoPreview ? 'Telugu · Demo preview' : 'Live'));

    const transcriptHost = el('div', { class: 'journey-transcript' });
    function paintTranscript(rows) {
      transcriptHost.innerHTML = '';
      (rows || []).forEach((row) => {
        transcriptHost.appendChild(el('div', {
          class: 'journey-bubble ' + (row.role === 'agent' || /maya/i.test(row.speaker || '') ? 'is-agent' : 'is-caller'),
        }, [
          el('div', { class: 'who' }, [
            (row.speaker || row.role || 'Speaker'),
            row.language ? (' · ' + row.language) : '',
          ].join('')),
          el('div', { html: highlightText(row.text, row.highlights) }),
          row.demoPreview ? demoBadge(true) : null,
        ]));
      });
      if (!(rows || []).length) {
        transcriptHost.appendChild(el('p', { class: 'muted' }, c.note || 'No transcript yet.'));
      }
    }
    paintTranscript(c.transcript || []);

    const wave = el('div', { class: 'journey-wave', style: 'height:40px;margin:8px 0 12px' });

    const startBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      disabled: !!c.demoPreview || !c.realtimeAvailable || !c.agentId,
      onclick: async () => {
        if (c.demoPreview) return toast('Demo preview call only. Switch to Live mode.', 'info');
        if (!c.agentId) return toast('Employee has no linked agent for realtime Talk.', 'err');
        if (JourneyState.talk && JourneyState.talk.running) {
          stopTalk();
          statusEl.textContent = 'Ended';
          startBtn.textContent = 'Start live call';
          return;
        }
        await startRealtimeCall(c.agentId, {
          onStatus: (s) => { statusEl.textContent = s; },
          onTick: (sec) => {
            const m = String(Math.floor(sec / 60)).padStart(2, '0');
            const s = String(sec % 60).padStart(2, '0');
            timerEl.textContent = m + ':' + s;
          },
          onTranscript: (row) => {
            const cur = Array.from(transcriptHost.querySelectorAll('.journey-bubble')).length;
            if (!cur) transcriptHost.innerHTML = '';
            transcriptHost.appendChild(el('div', {
              class: 'journey-bubble ' + (row.role === 'agent' ? 'is-agent' : 'is-caller'),
            }, [
              el('div', { class: 'who' }, row.speaker || row.role || 'Speaker'),
              el('div', {}, row.text || ''),
            ]));
          },
        });
        startBtn.textContent = 'End call';
      },
    }, c.demoPreview ? 'Demo preview only' : (c.realtimeAvailable ? 'Start live call' : 'Realtime unavailable'));

    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-call-head' }, [statusPill, timerPill, langPill, c.demoPreview ? demoBadge(true) : null]),
      c.participant ? el('div', {}, [
        el('h3', {}, c.participant.name || 'Caller'),
        el('p', { class: 'sub' }, c.participant.context || ''),
      ]) : el('p', { class: 'sub' }, c.note || 'Realtime Talk uses the employee agent when available.'),
      wave,
      transcriptHost,
      el('div', { class: 'flex gap-2', style: 'margin-top:8px;flex-wrap:wrap;align-items:center' }, [
        startBtn,
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/talk' }, 'Open Talk'),
      ]),
      el('p', { class: 'journey-note' }, c.demoPreview
        ? 'Conversation labeled Demo preview. Not written to live call records.'
        : 'Live mode never invents transcripts. Fake lines appear only in Demo preview.'),
    ]);
  }

  async function startRealtimeCall(agentId, hooks) {
    stopTalk();
    const talk = { running: true, startedAt: Date.now(), pc: null, ws: null, stream: null, audio: el('audio', { autoplay: 'autoplay', playsinline: 'playsinline' }), timer: null };
    JourneyState.talk = talk;
    hooks.onStatus && hooks.onStatus('Connecting');
    try {
      talk.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const session = await api('/api/voice/session', { method: 'POST', timeoutMs: 15000, body: { agentId } });
      let turn = session.turnCredentials || null;
      if (!turn && session.turnCredentialsUrl) {
        try {
          const tr = await fetch(session.turnCredentialsUrl, { credentials: 'include' });
          if (tr.ok) turn = await tr.json();
        } catch (_) {}
      }
      const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
      if (turn && turn.uris && turn.uris.length) {
        iceServers.push({ urls: turn.uris, username: turn.username, credential: turn.password });
      }
      talk.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: turn ? 'relay' : 'all' });
      talk.stream.getTracks().forEach((track) => talk.pc.addTrack(track, talk.stream));
      talk.pc.ontrack = (event) => {
        if (event.track.kind === 'audio') {
          talk.audio.srcObject = event.streams[0];
          talk.audio.play().catch(() => {});
        }
      };
      talk.pc.onconnectionstatechange = () => {
        if (!talk.pc) return;
        if (talk.pc.connectionState === 'connected') {
          hooks.onStatus && hooks.onStatus('Connected');
          talk.timer = setInterval(() => {
            const sec = Math.max(0, Math.round((Date.now() - talk.startedAt) / 1000));
            hooks.onTick && hooks.onTick(sec);
          }, 1000);
        }
        if (talk.pc.connectionState === 'failed') {
          hooks.onStatus && hooks.onStatus('Failed');
          stopTalk();
        }
      };
      const peerId = 'PC-' + Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('');
      talk.ws = new WebSocket(session.signalingUrl);
      await new Promise((resolve, reject) => {
        talk.ws.onopen = resolve;
        talk.ws.onerror = () => reject(new Error('Realtime signaling connection failed'));
      });
      talk.ws.onmessage = async (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.type === 'answer') {
          await talk.pc.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp });
        } else if (message.type === 'ice-candidate') {
          const cand = message.payload && message.payload.candidate;
          if (cand) await talk.pc.addIceCandidate(cand).catch(() => {});
        } else if (message.type === 'call-ended') {
          hooks.onStatus && hooks.onStatus('Ended');
          stopTalk();
        } else if (message.type === 'error' || message.type === 'rtf-pipeline-error') {
          hooks.onStatus && hooks.onStatus('Failed');
        } else if (message.type === 'rtf-user-transcription') {
          const p = message.payload || {};
          hooks.onStatus && hooks.onStatus(p.final ? 'Listening' : 'Listening');
          if (p.text && p.final) hooks.onTranscript && hooks.onTranscript({ role: 'caller', speaker: 'Caller', text: p.text });
        } else if (message.type === 'rtf-bot-text') {
          const p = message.payload || {};
          if (p.text) hooks.onTranscript && hooks.onTranscript({ role: 'agent', speaker: 'Maya', text: p.text });
        } else if (message.type === 'rtf-bot-started-speaking') {
          hooks.onStatus && hooks.onStatus('Speaking');
        } else if (message.type === 'rtf-bot-stopped-speaking') {
          hooks.onStatus && hooks.onStatus('Listening');
        }
      };
      talk.pc.onicecandidate = (event) => {
        if (!talk.ws || talk.ws.readyState !== WebSocket.OPEN) return;
        talk.ws.send(JSON.stringify({
          type: 'ice-candidate',
          payload: {
            candidate: event.candidate ? {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
            } : null,
            pc_id: peerId,
          },
        }));
      };
      const offer = await talk.pc.createOffer();
      await talk.pc.setLocalDescription(offer);
      talk.ws.send(JSON.stringify({
        type: 'offer',
        payload: {
          sdp: offer.sdp,
          type: 'offer',
          pc_id: peerId,
          workflow_id: session.workflowId,
          workflow_run_id: session.workflowRunId,
        },
      }));
      document.body.appendChild(talk.audio);
    } catch (err) {
      hooks.onStatus && hooks.onStatus('Failed');
      stopTalk();
      toast(err.message || 'Realtime voice call failed.', 'err');
      throw err;
    }
  }

  function renderOutcome(data) {
    const o = data.outcome || {};
    const crumbs = el('div', { class: 'journey-breadcrumb' }, []);
    (o.breadcrumb || ['CONVERSATION', 'UNDERSTANDING', 'OUTCOME', 'NEXT ACTION']).forEach((label, idx, arr) => {
      crumbs.appendChild(el('span', { class: label === (o.active || 'OUTCOME') ? 'is-on' : '' }, label));
      if (idx < arr.length - 1) crumbs.appendChild(el('span', { class: 'sep' }, '--'));
    });

    const fields = (o.fields || []).map((f) => el('div', {
      class: 'journey-card' + (f.success ? ' is-success' : ' is-soft'),
    }, [
      el('div', { class: 'eyebrow' }, f.label || f.key),
      el('h3', {}, String(f.value == null ? '-' : f.value)),
      f.provenance ? el('p', { class: 'prov' }, f.provenance) : null,
      f.demoPreview ? demoBadge(true) : null,
    ]));

    return el('div', { class: 'journey-body' }, [
      crumbs,
      el('div', { class: 'eyebrow' }, 'Structured outcome'),
      el('h3', {}, 'Customer context'),
      el('p', { class: 'sub' }, o.note || 'Normalized fields from real call outcomes when available.'),
      el('div', { class: 'journey-field-grid', style: 'margin-top:10px' }, fields.length ? fields : [
        el('div', { class: 'journey-card' }, [
          el('p', { class: 'muted' }, 'No structured outcome fields yet.'),
          (o.schema || []).length
            ? el('p', { class: 'journey-note' }, 'Configured schema: ' + o.schema.map((s) => s.label || s.key).join(', '))
            : null,
        ]),
      ]),
      o.summary ? el('div', { class: 'journey-card', style: 'margin-top:8px' }, [
        el('div', { class: 'eyebrow' }, 'Summary'),
        el('p', {}, o.summary),
      ]) : null,
      o.demoPreview ? demoBadge(true) : null,
    ]);
  }

  function renderNext(data) {
    const n = data.next || {};
    const action = n.nextAction || {};
    const metrics = (n.metrics || []).map((m) => el('div', { class: 'journey-card' }, [
      el('strong', {}, String(m.value == null ? '-' : m.value)),
      el('span', {}, m.label || m.key),
      m.demoPreview ? demoBadge(true) : null,
    ]));
    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-card is-soft' }, [
        el('div', { class: 'eyebrow' }, 'Next action'),
        el('h3', {}, action.title || '-'),
        el('p', { class: 'sub' }, [
          action.owner ? ('Owner ' + action.owner) : null,
          action.owner && action.detail ? ' · ' : '',
          action.detail || '',
        ].join('')),
        action.demoPreview ? demoBadge(true) : null,
      ]),
      metrics.length
        ? el('div', { class: 'journey-metrics' }, metrics)
        : el('p', { class: 'journey-note' }, 'Metrics hidden until real employee analytics exist.'),
      el('div', { class: 'journey-card is-soft' }, [
        el('div', { class: 'eyebrow' }, 'Outcome summary'),
        el('p', {}, (n.outcomeSummary && n.outcomeSummary.text)
          || 'No Groq auto-summary yet. Complete a live call with summary pipeline enabled.'),
        n.outcomeSummary && n.outcomeSummary.demoPreview ? demoBadge(true) : null,
      ]),
      n.disclaimer ? el('p', { class: 'journey-note' }, n.disclaimer) : null,
      n.demoPreview ? demoBadge(true) : null,
    ]);
  }

  const RENDERERS = {
    employee: renderEmployee,
    knowledge: renderKnowledge,
    language: renderLanguage,
    routing: renderRouting,
    call: renderCall,
    outcome: renderOutcome,
    next: renderNext,
  };

  async function setMode(mode) {
    JourneyState.mode = mode === 'demo' ? 'demo' : 'live';
    saveLocal({ mode: JourneyState.mode, step: JourneyState.step });
    try {
      await saveJourney({ mode: JourneyState.mode, step: JourneyState.step });
    } catch (_) {}
    await refresh();
  }

  async function goStep(stepId) {
    JourneyState.step = stepId;
    saveLocal({ step: stepId, mode: JourneyState.mode });
    try {
      await saveJourney({ step: stepId, mode: JourneyState.mode });
    } catch (_) {}
    await refresh();
  }

  async function refresh() {
    const root = document.getElementById('ai-employee-journey-root');
    if (!root) return;
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'muted' }, 'Loading journey…'));
    try {
      const payload = await fetchJourney({ step: JourneyState.step, mode: JourneyState.mode });
      JourneyState.payload = payload;
      JourneyState.step = payload.currentStep || JourneyState.step;
      JourneyState.mode = payload.mode || JourneyState.mode;
      paint(root, payload);
    } catch (err) {
      root.innerHTML = '';
      root.appendChild(el('div', { class: 'journey-card' }, [
        el('h3', {}, 'Journey unavailable'),
        el('p', { class: 'muted' }, err.message || 'Could not load AI Employee journey.'),
      ]));
    }
  }

  function paint(root, data) {
    stopTalk();
    const idx = stepIndex(JourneyState.step);
    const step = STEPS[idx];
    const title = step.id === 'knowledge' && data.employee && data.employee.name
      ? ('Teach ' + data.employee.name + ' the job')
      : step.title;

    const rail = el('aside', { class: 'journey-rail' }, STEPS.map((s) => el('button', {
      class: 'journey-rail-item' + (s.id === step.id ? ' is-active' : ''),
      type: 'button',
      onclick: () => goStep(s.id),
      html: icon(s.id) + '<span>' + esc(s.label) + '</span>',
    })).concat([
      el('div', { class: 'journey-rail-foot' }, 'Step ' + (idx + 1) + ' of 7'),
    ]));

    const bodyHost = el('div', { id: 'journey-step-body' });
    const renderer = RENDERERS[step.id] || renderEmployee;
    bodyHost.appendChild(renderer(data));

    const back = el('button', {
      class: 'btn-back',
      type: 'button',
      disabled: idx === 0,
      onclick: () => goStep(STEPS[Math.max(0, idx - 1)].id),
    }, 'Back');

    const continueBtn = el('button', {
      class: 'btn-continue',
      type: 'button',
      onclick: async () => {
        if (idx >= STEPS.length - 1) {
          JourneyState.step = 'employee';
          JourneyState.mode = 'live';
          JourneyState.dirtyPrompt = null;
          saveLocal({ step: 'employee', mode: 'live' });
          try { await saveJourney({ step: 'employee', mode: 'live' }); } catch (_) {}
          toast('Journey restarted.', 'ok');
          await refresh();
          return;
        }
        await goStep(STEPS[idx + 1].id);
      },
      html: idx >= STEPS.length - 1
        ? '<span style="margin-right:6px">▶</span> Start over'
        : 'Continue',
    });

    const main = el('div', { class: 'journey-main' }, [
      el('div', { class: 'journey-top' }, [
        el('h2', {}, title),
        el('div', { class: 'step-meta' }, 'Step ' + (idx + 1) + ' of 7'),
      ]),
      el('div', { class: 'journey-mode-bar' }, [
        el('div', { class: 'mode-toggle' }, [
          el('button', {
            type: 'button',
            class: JourneyState.mode === 'live' ? 'is-on' : '',
            onclick: () => setMode('live'),
          }, 'Live'),
          el('button', {
            type: 'button',
            class: JourneyState.mode === 'demo' ? 'is-on' : '',
            onclick: () => setMode('demo'),
          }, 'Demo preview'),
        ]),
        JourneyState.mode === 'demo' ? demoBadge(true) : el('span', { class: 'journey-note' }, 'Live mode uses real Astra Voice entities only.'),
      ]),
      bodyHost,
      el('div', { class: 'journey-footer' }, [back, continueBtn]),
    ]);

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'journey-shell' }, [rail, main]));
  }

  async function viewAiEmployeeSetup(root) {
    stopTalk();
    const local = loadLocal();
    JourneyState.step = local.step || 'employee';
    JourneyState.mode = local.mode || 'live';
    JourneyState.dirtyPrompt = null;

    root.appendChild(el('div', { class: 'view-head' }, [
      el('h2', {}, 'AI Employee Setup'),
      el('p', {}, 'Guided Astra Voice journey for your investor-demo employee. Existing console pages stay unchanged.'),
    ]));
    const host = el('div', { id: 'ai-employee-journey-root' });
    root.appendChild(host);
    await refresh();
  }

  window.AstraAiEmployeeJourney = {
    view: viewAiEmployeeSetup,
    isEnabled: function isEnabled() {
      return !!(State.me && State.me.features && State.me.features.aiEmployeeJourney);
    },
    stopTalk,
  };
})();
