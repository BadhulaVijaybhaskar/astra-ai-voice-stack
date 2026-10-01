/**
 * Astra Voice. Guided AI Employee Setup / Demo Journey (add-on UI).
 * Layout: top horizontal 01-07 progress rail + Frame (84px icon rail + panel).
 * Feature flag: ENABLE_AI_EMPLOYEE_JOURNEY. Route: #/ai-employee-setup
 * Live data wiring preserved. Demo preview labeled. No em dashes.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'astra_ai_employee_journey_v1';
  const STEPS = [
    { id: 'employee', label: 'Employee', timeline: 'Employee', subtitle: 'Create or select your AI Employee', title: 'Your AI employee' },
    { id: 'knowledge', label: 'Knowledge', timeline: 'Knowledge', subtitle: 'Teach Maya about your business', title: 'Teach Maya the job' },
    { id: 'language', label: 'Language', timeline: 'Voice & Language', subtitle: 'Choose voice, mode, and languages', title: 'Voice & language' },
    { id: 'routing', label: 'Routing', timeline: 'Routing & Connections', subtitle: 'Connect channels and actions', title: 'Connect customers' },
    { id: 'call', label: 'Call', timeline: 'Live Conversation', subtitle: 'Maya speaks with your customer', title: 'Live conversation' },
    { id: 'outcome', label: 'Outcome', timeline: 'Structured Outcome', subtitle: 'Call to structured business data', title: 'Structured result' },
    { id: 'next', label: 'Next', timeline: 'Next Action', subtitle: 'Turn conversations into outcomes', title: 'Next action' },
  ];

  const JourneyState = {
    payload: null,
    step: 'employee',
    mode: 'live',
    path: 'configure', // configure | demonstrate
    dirtyPrompt: null,
    talk: null,
    voicePlaying: false,
    voiceProgress: 0,
    voiceTimer: null,
    selectedVoiceId: 'maya',
    voiceMode: 'astra_auto',
    voiceSpeed: 0.9,
    autoStartTalk: false,
  };

  function stepIndex(id) {
    const i = STEPS.findIndex((s) => s.id === id);
    return i >= 0 ? i : 0;
  }

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
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
      call: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
      outcome: '<path d="M7 3h10v18H7z"/><path d="M10 7h4M10 11h4M10 15h2"/>',
      next: '<path d="M4 19h16"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-6"/>',
      book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z"/>',
      file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
      list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
      mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/>',
      langs: '<path d="M5 7h8M9 7c0 6-4 10-4 10M13 7c0 4 2 8 6 10"/>',
      clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
      cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
      spark: '<path d="M12 3l1.2 4.2L17 8.5l-3.8 1.3L12 14l-1.2-4.2L7 8.5l3.8-1.3z"/>',
      check: '<path d="m5 12 4 4 10-10"/>',
    };
    return '<svg viewBox="0 0 24 24">' + (paths[name] || paths.employee) + '</svg>';
  }

  function statusKey(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return 'ready';
    if (/qualif/.test(s)) return 'qualified';
    if (/call(ing)?/.test(s) && !/callback/.test(s)) return 'calling';
    if (/connect/.test(s)) return 'connected';
    if (/complete|ended|done/.test(s)) return 'completed';
    if (/fail|error/.test(s)) return 'failed';
    if (/ready|active|live/.test(s)) return 'ready';
    return s.replace(/\s+/g, '-');
  }

  function statusPill(label, opts) {
    const text = String(label || 'Ready');
    return el('span', {
      class: 'journey-pill' + ((opts && opts.outline) ? ' is-outline' : ''),
      'data-status': statusKey(text),
    }, text);
  }

  function demoBadge(show) {
    if (!show) return null;
    return el('span', { class: 'journey-demo-badge' }, 'DEMO PREVIEW');
  }

  function chromeLabel() {
    // Global chrome: AstraConnect Workspace. Demo adds DEMO PREVIEW badge separately.
    return 'AstraConnect Workspace';
  }

  function pathCtas(data) {
    return el('div', { class: 'journey-path-ctas' }, [
      el('button', {
        class: 'journey-cta journey-cta-configure'
          + (JourneyState.path === 'configure' && JourneyState.mode === 'live' ? ' is-on' : ''),
        type: 'button',
        onclick: () => startConfigure(),
      }, [
        el('strong', {}, 'Configure Maya'),
        el('span', {}, '7-step setup with Live workspace data'),
      ]),
      el('button', {
        class: 'journey-cta journey-cta-live'
          + (JourneyState.path === 'demonstrate' ? ' is-on' : ''),
        type: 'button',
        onclick: () => startLiveDemo(),
      }, [
        el('strong', {}, 'Run Live Demo'),
        el('span', {}, 'Skip config · Live Talk → outcome → next action'),
      ]),
    ]);
  }

  async function startConfigure() {
    JourneyState.path = 'configure';
    JourneyState.mode = 'live';
    JourneyState.autoStartTalk = false;
    JourneyState.step = 'employee';
    stopTalk();
    stopVoicePreview();
    saveLocal({ path: 'configure', mode: 'live', step: 'employee' });
    try { await saveJourney({ mode: 'live', step: 'employee' }); } catch (_) {}
    toast('Configure Maya · Live workspace.', 'ok');
    await refresh();
  }

  async function startLiveDemo() {
    JourneyState.path = 'demonstrate';
    JourneyState.mode = 'live';
    JourneyState.autoStartTalk = true;
    JourneyState.step = 'call';
    stopVoicePreview();
    saveLocal({ path: 'demonstrate', mode: 'live', step: 'call' });
    try { await saveJourney({ mode: 'live', step: 'call' }); } catch (_) {}
    toast('Run Live Demo · jumping to Live conversation.', 'ok');
    await refresh();
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
    try { if (t.ws && t.ws.readyState < 2) t.ws.close(); } catch (_) {}
    try {
      if (t.pc) {
        t.pc.getSenders().forEach((s) => s.track && s.track.stop());
        t.pc.close();
      }
    } catch (_) {}
    try { if (t.stream) t.stream.getTracks().forEach((tr) => tr.stop()); } catch (_) {}
    if (t.timer) clearInterval(t.timer);
    if (t.audio) t.audio.srcObject = null;
    JourneyState.talk = null;
  }

  function stopVoicePreview() {
    JourneyState.voicePlaying = false;
    JourneyState.voiceProgress = 0;
    if (JourneyState.voiceTimer) {
      clearInterval(JourneyState.voiceTimer);
      JourneyState.voiceTimer = null;
    }
  }

  function highlightText(text, highlights) {
    const raw = String(text || '');
    if (!Array.isArray(highlights) || !highlights.length) return esc(raw);
    let out = esc(raw);
    highlights.forEach((h) => {
      const needle = String(h || '').trim();
      if (!needle) return;
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(re, (m) => '<mark>' + m + '</mark>');
    });
    return out;
  }

  function panelTitle(data) {
    const idx = stepIndex(JourneyState.step);
    const step = STEPS[idx];
    if (step.id === 'knowledge') {
      const name = (data.employee && data.employee.name) || 'Maya';
      return 'Teach ' + name + ' the job';
    }
    return step.title;
  }

  /* ---- Step renderers (marketing structure + live/demo data) ---- */

  function renderEmployee(data) {
    const e = data.employee || {};
    if (e.empty) {
      return el('div', { class: 'journey-body' }, [
        pathCtas(data),
        el('div', { class: 'journey-empty' }, [
          el('p', {}, e.message || 'No employee found.'),
          el('a', { class: 'btn btn-primary', href: '#/employees?create=1', style: 'margin-top:12px' }, 'Create employee'),
        ]),
      ]);
    }
    const name = e.name || 'Employee';
    const ready = e.readiness || {};
    return el('div', { class: 'journey-body' }, [
      pathCtas(data),
      el('div', { class: 'journey-profile' }, [
        el('div', { class: 'journey-avatar' }, initials(name)),
        el('div', { class: 'meta' }, [
          el('strong', {}, name),
          el('div', { class: 'role-line' }, (e.role || 'Role') + ' · ' + (e.team || 'Team')),
        ]),
        el('div', {
          class: 'journey-status',
          'data-status': statusKey(e.status || 'Ready'),
        }, [el('span', { class: 'dot' }), e.status || 'Ready']),
      ]),
      el('div', { class: 'journey-card' }, [
        el('div', { class: 'journey-job-title' }, 'Job'),
        el('p', { class: 'journey-job-body' }, e.job || '-'),
      ]),
      el('div', { class: 'journey-checklist' }, [
        el('div', { class: 'journey-check' + (ready.instructionsReady ? '' : ' is-pending') },
          ready.instructionsReady ? 'Instructions ready' : 'Instructions needed'),
        el('div', { class: 'journey-check' + (ready.knowledgeAdded ? '' : ' is-pending') },
          ready.knowledgeAdded ? 'Knowledge added' : 'Knowledge needed'),
        el('div', { class: 'journey-check' + (ready.voiceConfigured ? '' : ' is-pending') },
          ready.voiceConfigured ? 'Voice configured' : 'Voice needed'),
        el('div', { class: 'journey-check' + (ready.routingConfigured ? '' : ' is-pending') },
          ready.routingConfigured ? 'Routing configured' : 'Routing needed'),
        el('div', { class: 'journey-check' + (ready.outcomeFieldsSet ? '' : ' is-pending') },
          ready.outcomeFieldsSet ? 'Outcome fields set' : 'Outcome fields needed'),
      ]),
      e.demoPreview ? demoBadge(true) : null,
    ]);
  }

  function renderKnowledge(data) {
    const k = data.knowledge || {};
    const prompt = JourneyState.dirtyPrompt != null ? JourneyState.dirtyPrompt : (k.systemPrompt || '');
    const ta = el('textarea', {
      class: 'journey-textarea',
      rows: '4',
      disabled: !!k.demoPreview,
      oninput: (ev) => { JourneyState.dirtyPrompt = ev.target.value; },
    });
    ta.value = prompt;

    const fileIcon = el('span', { html: icon('file') });
    const kbItems = (k.knowledge || []).length
      ? (k.knowledge || []).map((item) => el('div', { class: 'journey-kb-item' }, [
        el('span', { html: icon('file') }),
        el('b', { class: 'title' }, item.title || 'Knowledge'),
        el('span', { class: 'meta' }, item.meta || item.kind || ''),
      ]))
      : [el('p', { class: 'journey-note' }, 'No knowledge attached yet. Add file, text, or URL from Training.')];

    const rulesHost = el('div', { class: 'journey-rules' });
    (k.qualificationRules || []).forEach((rule, idx) => {
      rulesHost.appendChild(el('button', {
        class: 'journey-rule',
        type: 'button',
        role: 'switch',
        'aria-checked': rule.enabled ? 'true' : 'false',
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
      }, [
        el('span', {}, rule.label || rule.id),
        el('span', { class: 'journey-toggle' + (rule.enabled ? ' is-on' : '') }),
      ]));
    });
    if (!(k.qualificationRules || []).length) {
      rulesHost.appendChild(el('p', { class: 'journey-note' }, 'No qualification rules yet.'));
    }

    const saveBtn = k.demoPreview ? null : el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      style: 'align-self:start',
      onclick: async () => {
        try {
          await saveJourney({
            mode: 'live',
            step: 'knowledge',
            instructions: JourneyState.dirtyPrompt != null ? JourneyState.dirtyPrompt : (k.systemPrompt || ''),
          });
          JourneyState.dirtyPrompt = null;
          toast('System prompt saved to employee instructions.', 'ok');
          await refresh();
        } catch (err) {
          toast(err.message || 'Could not save prompt.', 'err');
        }
      },
    }, 'Save prompt');

    return el('div', { class: 'journey-body' }, [
      el('label', { class: 'journey-field-label' }, [
        el('span', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, [
          'System prompt',
          saveBtn,
        ]),
        ta,
      ]),
      el('div', {}, [
        el('p', { class: 'journey-section-label', style: 'text-transform:none;letter-spacing:0;font-size:.875rem;font-weight:650;color:#051223' }, [
          el('span', { html: icon('book') }),
          ' Business knowledge',
        ]),
        el('div', { class: 'journey-kb-row' }, kbItems),
        k.demoPreview ? null : el('a', {
          class: 'btn btn-ghost btn-sm',
          href: data.employeeId ? ('#/employees?id=' + encodeURIComponent(data.employeeId) + '&tab=training') : '#/knowledge',
          style: 'margin-top:8px',
        }, 'Add knowledge'),
      ]),
      el('div', {}, [
        el('p', { class: 'journey-section-label', style: 'text-transform:none;letter-spacing:0;font-size:.875rem;font-weight:650;color:#051223' }, [
          el('span', { html: icon('list') }),
          ' Qualification rules',
        ]),
        rulesHost,
      ]),
      k.demoPreview ? demoBadge(true) : null,
    ]);
  }

  function renderLanguage(data) {
    const L = data.language || {};
    const voice = L.voice || {};
    const voiceOptions = voice.options && voice.options.length ? voice.options : [
      { id: 'maya', name: 'Maya', description: 'Lead qualification · Demo voice', selected: true, demoPreview: !!L.demoPreview },
      { id: 'dev', name: 'Dev', description: 'Customer support · Demo voice', selected: false, demoPreview: !!L.demoPreview },
      { id: 'sara', name: 'Sara', description: 'Appointments · Demo voice', selected: false, demoPreview: !!L.demoPreview },
    ];
    if (!voiceOptions.some((v) => v.id === JourneyState.selectedVoiceId)) {
      const sel = voiceOptions.find((v) => v.selected) || voiceOptions[0];
      JourneyState.selectedVoiceId = sel ? sel.id : 'maya';
    }

    const options = voiceOptions.map((opt) => el('button', {
      class: 'journey-voice-opt' + (opt.id === JourneyState.selectedVoiceId || opt.selected ? ' is-selected' : ''),
      type: 'button',
      'aria-pressed': (opt.id === JourneyState.selectedVoiceId || opt.selected) ? 'true' : 'false',
      onclick: () => {
        JourneyState.selectedVoiceId = opt.id;
        stopVoicePreview();
        refresh();
      },
    }, [
      el('strong', {}, [
        (opt.id === JourneyState.selectedVoiceId || opt.selected) ? el('span', { class: 'tick' }, '✓') : null,
        opt.name,
      ]),
      el('span', {}, opt.description || ''),
    ]));

    const selected = voiceOptions.find((v) => v.id === JourneyState.selectedVoiceId) || voiceOptions[0];
    const quote = '“Hi, this is ' + ((selected && selected.name) || 'Maya') + ' from Astra Voice. Is now a good time?”';

    const wave = el('div', { class: 'journey-wave-bars', 'aria-hidden': 'true' });
    for (let i = 0; i < 28; i++) {
      const h = 6 + ((i * 7) % 16);
      const on = (i / 28) * 100 < JourneyState.voiceProgress;
      wave.appendChild(el('i', {
        class: on ? 'is-on' : '',
        style: 'height:' + h + 'px',
      }));
    }

    const playBtn = el('button', {
      class: 'journey-play',
      type: 'button',
      'aria-label': JourneyState.voicePlaying ? 'Pause sample' : 'Play voice sample',
      onclick: async () => {
        if (JourneyState.voicePlaying) {
          stopVoicePreview();
          return refresh();
        }
        JourneyState.voicePlaying = true;
        JourneyState.voiceProgress = 0;
        if (JourneyState.voiceTimer) clearInterval(JourneyState.voiceTimer);
        JourneyState.voiceTimer = setInterval(() => {
          JourneyState.voiceProgress += 4;
          if (JourneyState.voiceProgress >= 100) {
            stopVoicePreview();
          }
          const root = document.getElementById('ai-employee-journey-root');
          if (root && JourneyState.payload) paint(root, JourneyState.payload, { skipFetch: true });
        }, 120);
        if (!L.demoPreview) {
          try {
            const res = await fetch('/api/tts', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: 'Hi, this is Maya from Astra Voice. Is now a good time?', provider: 'rumik', model: 'mulberry' }),
            });
            if (res.ok) {
              const buf = await res.arrayBuffer();
              const audio = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
              audio.play().catch(() => {});
            }
          } catch (_) {}
        }
        refresh();
      },
      html: JourneyState.voicePlaying
        ? '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    });

    // Language chips: prefer EN/HI/TE/TA like marketing for demo; full catalog in live
    let langs = L.languages || [];
    if (L.demoPreview) {
      langs = langs.filter((l) => ['EN', 'HI', 'TE', 'TA', 'KN', 'ML', 'MR', 'BN'].includes(l.id));
      if (!langs.length) {
        langs = [
          { id: 'EN', label: 'English', selected: true, tone: 'tested', status: 'Tested', demoPreview: true },
          { id: 'HI', label: 'Hindi', selected: false, tone: 'tested', status: 'Tested', demoPreview: true },
          { id: 'TE', label: 'Telugu', selected: false, tone: 'tested', status: 'Tested', demoPreview: true },
          { id: 'TA', label: 'Tamil', selected: false, tone: 'tested', status: 'Tested', demoPreview: true },
          { id: 'KN', label: 'Kannada', selected: false, tone: 'validation', status: 'Ready for validation', demoPreview: true },
          { id: 'ML', label: 'Malayalam', selected: false, tone: 'validation', status: 'Ready for validation', demoPreview: true },
          { id: 'MR', label: 'Marathi', selected: false, tone: 'validation', status: 'Ready for validation', demoPreview: true },
          { id: 'BN', label: 'Bengali', selected: false, tone: 'validation', status: 'Ready for validation', demoPreview: true },
        ];
      }
    }

    const statusChip = (lang) => {
      const tone = lang.tone
        || (/tested/i.test(lang.status || '') ? 'tested'
          : /validation/i.test(lang.status || '') ? 'validation' : 'unavailable');
      const label = tone === 'tested' ? 'TESTED'
        : (tone === 'validation' ? 'READY FOR VALIDATION' : 'UNAVAILABLE');
      return el('span', { class: 'journey-lang-status is-' + tone }, label);
    };

    const chips = langs.map((lang) => {
      const unavailable = (lang.tone === 'unavailable') || /unavailable/i.test(lang.status || '');
      return el('button', {
        class: 'journey-chip' + (lang.selected ? ' is-selected' : '') + (unavailable ? ' is-unavailable' : ''),
        type: 'button',
        disabled: unavailable && !L.demoPreview ? false : undefined,
        'aria-pressed': lang.selected ? 'true' : 'false',
        onclick: async () => {
          if (unavailable) {
            toast('Language not available yet.', 'info');
            return;
          }
          if (L.demoPreview || lang.demoPreview) {
            langs.forEach((l) => { l.selected = l.id === lang.id; });
            L.note = lang.id === 'TE' || /telugu/i.test(lang.label || '')
              ? 'Telugu selected for this illustrative demo · outcome fields stay in English.'
              : null;
            return refresh();
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
        el('span', { class: 'journey-chip-label' }, lang.label),
        statusChip(lang),
      ]);
    });

    const selectedLang = langs.find((l) => l.selected);
    const bannerText = L.note
      || (selectedLang && /telugu/i.test(selectedLang.label || '')
        ? 'Telugu selected for this illustrative demo · outcome fields stay in English.'
        : null);

    const voiceModes = (L.voiceModes && L.voiceModes.length)
      ? L.voiceModes
      : [
        { id: 'astra_auto', label: 'Astra Auto' },
        { id: 'dograh_managed', label: 'Dograh Managed' },
        { id: 'byok', label: 'BYOK' },
      ];
    const activeMode = L.voiceMode || 'astra_auto';
    const modePills = el('div', { class: 'journey-voice-modes', role: 'group', 'aria-label': 'Voice mode' },
      voiceModes.map((m) => el('button', {
        class: 'journey-voice-mode' + (m.id === activeMode ? ' is-active' : ''),
        type: 'button',
        'aria-pressed': m.id === activeMode ? 'true' : 'false',
        onclick: async () => {
          if (L.demoPreview) {
            L.voiceMode = m.id;
            return refresh();
          }
          try {
            await saveJourney({
              mode: 'live',
              step: 'language',
              voiceDraft: {
                voiceMode: m.id,
                provider: m.id === 'byok' ? 'rumik' : (m.id === 'dograh_managed' ? 'dograh' : 'auto'),
                apply_live: false,
                label: m.label,
              },
            });
            toast(m.label + ' draft saved. Maya production voice unchanged.', 'ok');
            await refresh();
          } catch (err) {
            toast(err.message || 'Could not save voice mode.', 'err');
          }
        },
      }, m.label))
    );

    const speedVal = (voice.speed != null && !Number.isNaN(Number(voice.speed)))
      ? Number(voice.speed)
      : 0.9;
    const speedRow = el('div', { class: 'journey-speed-row' }, [
      el('label', { for: 'journeySpeed' }, 'Speed'),
      el('input', {
        id: 'journeySpeed',
        type: 'range',
        min: '0.5',
        max: '1.5',
        step: '0.1',
        value: String(speedVal),
        oninput: (e) => {
          const v = Number(e.target.value);
          const label = document.getElementById('journeySpeedVal');
          if (label) label.textContent = v.toFixed(1) + 'x';
        },
        onchange: async (e) => {
          const v = Number(e.target.value);
          if (L.demoPreview) {
            voice.speed = v;
            return refresh();
          }
          try {
            await saveJourney({
              mode: 'live',
              step: 'language',
              voiceDraft: Object.assign({}, voice.draft || {}, {
                speed: v,
                apply_live: false,
              }),
            });
            toast('Speed draft ' + v.toFixed(1) + 'x saved.', 'ok');
          } catch (err) {
            toast(err.message || 'Could not save speed.', 'err');
          }
        },
      }),
      el('span', { id: 'journeySpeedVal', class: 'journey-speed-val' }, speedVal.toFixed(1) + 'x'),
    ]);

    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-voice-panel' }, [
        el('p', { class: 'journey-section-label' }, [el('span', { html: icon('mic') }), ' VOICE']),
        el('h3', {}, voice.title || 'Maya · Natural Indian English'),
        el('p', { class: 'sub' }, voice.subtitle || (L.demoPreview
          ? 'Demo voice profile for Maya - illustrative sample.'
          : 'Draft preview only. Saving does not flip Maya production voice.')),
        modePills,
        speedRow,
        el('div', { class: 'journey-voice-options' }, options),
        el('div', { class: 'journey-preview-bar' }, [
          playBtn,
          el('div', { style: 'min-width:0;flex:1' }, [
            el('p', { class: 'journey-preview-quote' }, quote),
            wave,
          ]),
        ]),
      ]),
      el('div', { class: 'journey-lang-panel' }, [
        el('p', { class: 'journey-section-label is-muted' }, [el('span', { html: icon('langs') }), ' LANGUAGE']),
        el('h3', {}, 'Supported languages'),
        el('p', { class: 'sub' }, 'Speak to customers in English and selected regional languages.'),
        el('div', { class: 'journey-lang-chips' }, chips),
        bannerText ? el('p', { class: 'journey-info-banner' }, bannerText) : null,
        L.catalog && Array.isArray(L.catalog.languages) && L.catalog.languages.length
          ? el('p', { class: 'journey-note', style: 'margin-top:8px' },
            L.catalog.languages.length + ' catalog languages available for draft preview.')
          : null,
      ]),
    ]);
  }

  function renderRouting(data) {
    const r = data.routing || {};
    const num = r.businessNumber || {};
    const hours = r.workingHours || {};
    const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    // Marketing uses Mon-Sun as M T W T F S S; our hours.days use 0=Sun.
    const activeMap = [false, false, false, false, false, false, false];
    (hours.days || [1, 2, 3, 4, 5]).forEach((d) => {
      if (d >= 1 && d <= 6) activeMap[d - 1] = true;
      if (d === 0) activeMap[6] = true;
    });
    if (hours.mode === 'always') activeMap.fill(true);

    const days = dayLabels.map((label, idx) => el('button', {
      class: 'journey-day' + (activeMap[idx] ? ' is-on' : ''),
      type: 'button',
      'aria-pressed': activeMap[idx] ? 'true' : 'false',
    }, label));

    const routingText = (r.routing || []).length
      ? (r.routing || []).map((rule) => (rule.when || '') + ' → ' + (rule.then || '')).join(' · ')
      : (r.workflowName ? ('Workflow · ' + r.workflowName) : 'Assign a workflow or configure Actions.');

    const cal = r.calendar || {};
    const primary = cal.primary || {};
    const secondary = cal.secondary || {};
    const connected = /connected/i.test(String(primary.status || ''));

    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-routing-panel' }, [
        el('div', { class: 'journey-routing-row' }, [
          el('div', { class: 'ico', html: icon('routing') }),
          el('div', {}, [
            el('div', { class: 'label' }, 'Business number'),
            el('div', { class: 'value' },
              num.e164
                ? ((num.e164 || '-') + (num.direction ? (' · ' + num.direction) : ''))
                : (num.note || ('Unassigned · prefer ' + (num.preferredDid || '+918065353938')))),
          ]),
        ]),
        el('div', { class: 'journey-routing-row' }, [
          el('div', { class: 'ico', html: icon('routing') }),
          el('div', {}, [
            el('div', { class: 'label' }, 'Routing'),
            el('div', { class: 'value' }, routingText),
          ]),
        ]),
      ]),
      el('div', {}, [
        el('p', { class: 'journey-hours-head' }, [
          el('span', { html: icon('clock') }),
          ' Working hours · ' + (hours.label || '09:00 – 19:00 IST'),
        ]),
        el('div', { class: 'journey-days' }, days),
      ]),
      el('div', {}, [
        el('p', { class: 'journey-cal-head' }, [el('span', { html: icon('cal') }), ' Calendar']),
        el('div', { class: 'journey-cal-grid' }, [
          el('div', { class: 'journey-cal-card' + (connected ? ' is-connected' : '') }, [
            el('span', {}, primary.label || 'Configured calendar'),
            connected
              ? el('span', { class: 'ok' }, [el('span', { html: icon('check') }), ' Connected'])
              : el('span', { class: 'journey-note' }, primary.status || 'Not connected'),
          ]),
          el('div', { class: 'journey-cal-card' }, [
            el('span', {}, secondary.label || 'Second calendar'),
            el('button', {
              class: 'journey-connect-btn',
              type: 'button',
              onclick: () => toast('Connect additional calendars from Integrations.', 'info'),
            }, secondary.status === 'Connected' ? 'Connected' : 'Connect'),
          ]),
        ]),
        primary.note || r.demoPreview
          ? el('p', { class: 'journey-note', style: 'margin-top:8px' },
            primary.note || 'Illustrative setup · no external account is connected.')
          : null,
        el('div', { class: 'flex gap-2', style: 'margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
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
          }, 'Test connection'),
          el('a', { class: 'btn btn-ghost btn-sm', href: '#/integrations' }, 'Change provider'),
        ]),
      ]),
    ]);
  }

  function renderCall(data) {
    const c = data.call || {};
    // Live never pretends Connected. Demo preview may show illustrative Connected.
    const initialStatus = c.demoPreview
      ? (c.status || 'Connected')
      : ((JourneyState.talk && JourneyState.talk.running) ? 'Connected' : (c.status || 'Ready'));
    const statusEl = el('span', {
      class: 'journey-pill',
      'data-status': statusKey(initialStatus),
    }, initialStatus);
    const timerEl = el('span', {}, (JourneyState.talk && JourneyState.talk.running)
      ? (c.timer || '00:00')
      : (c.demoPreview ? (c.timer || '00:00') : '00:00'));
    function setCallStatus(s) {
      statusEl.textContent = s;
      statusEl.setAttribute('data-status', statusKey(s));
    }

    const transcriptHost = el('div', { class: 'journey-transcript' });
    function paintTranscript(rows) {
      transcriptHost.innerHTML = '';
      (rows || []).forEach((row) => {
        const isAgent = row.role === 'agent' || /maya/i.test(row.speaker || '');
        transcriptHost.appendChild(el('div', {
          class: 'journey-bubble' + (isAgent ? '' : ' is-caller'),
        }, [
          el('div', { class: 'who' }, [
            (row.speaker || row.role || 'Speaker').toUpperCase(),
            row.language ? (' · ' + row.language) : '',
          ].join('')),
          el('div', { html: highlightText(row.text, row.highlights) }),
        ]));
      });
      if (!(rows || []).length) {
        transcriptHost.appendChild(el('p', { class: 'journey-note' }, c.note || 'No transcript yet.'));
      }
    }
    paintTranscript(c.transcript || []);

    const wave = el('div', { class: 'journey-wave-card', 'aria-hidden': 'true' });
    [28, 54, 78, 42, 90, 62, 36, 70, 48, 84, 58, 34, 76, 50, 66, 40, 88, 52, 30, 72].forEach((h) => {
      wave.appendChild(el('i', { style: 'height:' + h + '%' }));
    });

    const toolChips = el('div', { class: 'journey-tool-chips' },
      (c.toolChips || c.statuses || ['Listening', 'Speaking', 'Tool call']).slice(0, 5).map((chip) =>
        el('span', { class: 'journey-tool-chip' }, chip)));

    async function beginLiveCall() {
      if (c.demoPreview) return toast('DEMO PREVIEW call only. Use Run Live Demo or switch to Live.', 'info');
      if (!c.agentId) return toast('Employee has no linked agent for realtime Talk.', 'err');
      if (JourneyState.talk && JourneyState.talk.running) {
        stopTalk();
        setCallStatus('Completed');
        startBtn.textContent = 'Start live call';
        return;
      }
      await startRealtimeCall(c.agentId, {
        onStatus: (s) => { setCallStatus(s); },
        onTick: (sec) => {
          const m = String(Math.floor(sec / 60)).padStart(2, '0');
          const s2 = String(sec % 60).padStart(2, '0');
          timerEl.textContent = m + ':' + s2;
        },
        onTranscript: (row) => {
          if (!transcriptHost.querySelector('.journey-bubble')) transcriptHost.innerHTML = '';
          const isAgent = row.role === 'agent';
          transcriptHost.appendChild(el('div', {
            class: 'journey-bubble' + (isAgent ? '' : ' is-caller'),
          }, [
            el('div', { class: 'who' }, (row.speaker || row.role || 'Speaker').toUpperCase()),
            el('div', {}, row.text || ''),
          ]));
        },
      });
      startBtn.textContent = 'End call';
    }

    const startBtn = el('button', {
      class: 'btn btn-primary btn-sm',
      type: 'button',
      disabled: !!c.demoPreview || !c.realtimeAvailable || !c.agentId,
      onclick: () => beginLiveCall(),
    }, c.demoPreview
      ? 'DEMO PREVIEW only'
      : (JourneyState.talk && JourneyState.talk.running
        ? 'End call'
        : (c.realtimeAvailable ? 'Start live call' : 'Realtime unavailable')));

    // Investor path: auto-start Live Talk once when entering demonstrate.
    if (JourneyState.autoStartTalk && !c.demoPreview && c.realtimeAvailable && c.agentId
      && !(JourneyState.talk && JourneyState.talk.running)) {
      JourneyState.autoStartTalk = false;
      setTimeout(() => { beginLiveCall().catch(() => {}); }, 80);
    } else if (JourneyState.autoStartTalk && (!c.realtimeAvailable || !c.agentId)) {
      JourneyState.autoStartTalk = false;
      if (!c.agentId) toast('Link an agent to Maya before Run Live Demo.', 'err');
      else toast('Realtime Talk is not configured yet (embed token / base URL).', 'info');
    }

    const callerName = (c.participant && c.participant.name)
      || (c.demoPreview ? 'Demo Caller' : (c.employeeName || 'Live caller'));

    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-call-top' }, [
        el('div', {}, [
          el('div', { class: 'journey-live-label' }, c.demoPreview ? 'DEMO PREVIEW CALL' : 'LIVE CALL'),
          el('h4', { class: 'journey-caller-name' }, callerName),
          el('p', { class: 'journey-note', style: 'margin-top:2px;font-size:.875rem' },
            (c.participant && c.participant.context) || (c.note || 'Realtime Talk uses the employee agent when available.')),
        ]),
        el('div', { class: 'journey-call-badges' }, [
          statusEl,
          el('span', { class: 'journey-pill is-dark' }, [timerEl]),
          el('span', { class: 'journey-pill is-outline' }, c.language || (c.demoPreview ? 'Telugu · DEMO PREVIEW' : 'Live')),
        ]),
      ]),
      toolChips,
      wave,
      transcriptHost,
      el('div', { class: 'journey-regional-foot' }, [
        statusPill('Regional language', { outline: true }),
        el('span', {}, c.demoPreview
          ? 'Illustrative Telugu + English · DEMO PREVIEW only'
          : 'Live mode never invents transcripts.'),
      ]),
      el('div', { class: 'flex gap-2', style: 'flex-wrap:wrap' }, [
        startBtn,
        el('a', { class: 'btn btn-ghost btn-sm', href: '#/talk' }, 'Open Talk'),
        c.demoPreview ? null : el('button', {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          onclick: () => goStep('outcome'),
        }, 'View structured result'),
      ]),
    ]);
  }

  async function startRealtimeCall(agentId, hooks) {
    stopTalk();
    const talk = {
      running: true,
      startedAt: Date.now(),
      pc: null,
      ws: null,
      stream: null,
      audio: el('audio', { autoplay: 'autoplay', playsinline: 'playsinline' }),
      timer: null,
    };
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
          hooks.onStatus && hooks.onStatus('Listening');
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
    const crumbs = el('div', { class: 'journey-breadcrumb' });
    const labels = o.breadcrumb || ['CONVERSATION', 'UNDERSTANDING', 'OUTCOME', 'NEXT ACTION'];
    labels.forEach((label, idx) => {
      crumbs.appendChild(el('span', {
        class: label === (o.active || 'OUTCOME') ? 'is-on' : '',
      }, label));
      if (idx < labels.length - 1) crumbs.appendChild(el('span', { class: 'sep' }));
    });

    const fields = (o.fields || []).map((f) => el('div', {
      class: 'journey-field-card' + (f.success || /status/i.test(f.key || '') ? ' is-success' : ''),
    }, [
      el('div', { class: 'eyebrow' }, f.label || f.key),
      el('b', { class: 'value' }, String(f.value == null ? '-' : f.value)),
      f.provenance ? el('p', { class: 'prov' }, f.provenance) : null,
    ]));

    return el('div', { class: 'journey-body' }, [
      el('div', {}, [
        el('p', { class: 'journey-eyebrow' }, 'STRUCTURED OUTCOME'),
        el('h4', { class: 'journey-context-title' }, 'Customer context'),
        el('p', { class: 'journey-note', style: 'margin-top:4px;font-size:.875rem' },
          o.note || 'Normalized English fields from the multilingual call.'),
      ]),
      crumbs,
      el('div', { class: 'journey-fields-stack' }, fields.length ? fields : [
        el('div', { class: 'journey-card' }, [
          el('p', { class: 'journey-note' }, 'No structured outcome fields yet.'),
          (o.schema || []).length
            ? el('p', { class: 'journey-note' }, 'Configured schema: ' + o.schema.map((s) => s.label || s.key).join(', '))
            : null,
        ]),
      ]),
      o.summary ? el('div', { class: 'journey-card' }, [
        el('div', { class: 'journey-eyebrow' }, 'Summary'),
        el('p', { style: 'margin-top:6px' }, o.summary),
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
    ]));
    return el('div', { class: 'journey-body' }, [
      el('div', { class: 'journey-card is-soft' }, [
        el('p', { class: 'journey-eyebrow' }, 'NEXT ACTION'),
        el('b', { style: 'display:block;margin-top:8px;font-size:1.25rem' }, action.title || '-'),
        el('p', { class: 'journey-note', style: 'margin-top:4px;font-size:.875rem' }, [
          action.owner ? ('Owner ' + action.owner) : null,
          action.owner && action.detail ? ' · ' : '',
          action.detail || '',
        ].join('')),
      ]),
      metrics.length
        ? el('div', { class: 'journey-metrics' }, metrics)
        : el('p', { class: 'journey-note' }, 'Metrics hidden until real employee analytics exist.'),
      el('div', { class: 'journey-card is-soft' }, [
        el('p', { class: 'journey-summary-head' }, [el('span', { html: icon('spark') }), ' Outcome summary']),
        el('p', { class: 'journey-note', style: 'margin-top:6px;font-size:.875rem' },
          (n.outcomeSummary && n.outcomeSummary.text)
            || 'No Groq auto-summary yet. Complete a live call with summary pipeline enabled.'),
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
    if (JourneyState.mode === 'demo') {
      JourneyState.path = 'configure';
      JourneyState.autoStartTalk = false;
      stopTalk();
    }
    saveLocal({ mode: JourneyState.mode, step: JourneyState.step, path: JourneyState.path });
    try { await saveJourney({ mode: JourneyState.mode, step: JourneyState.step }); } catch (_) {}
    await refresh();
  }

  async function goStep(stepId) {
    stopVoicePreview();
    if (stepId !== 'call') JourneyState.autoStartTalk = false;
    JourneyState.step = stepId;
    saveLocal({ step: stepId, mode: JourneyState.mode, path: JourneyState.path });
    try { await saveJourney({ step: stepId, mode: JourneyState.mode }); } catch (_) {}
    await refresh();
  }

  async function refresh() {
    const root = document.getElementById('ai-employee-journey-root');
    if (!root) return;
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
        el('p', { class: 'journey-note' }, err.message || 'Could not load AI Employee journey.'),
      ]));
    }
  }

  function paint(root, data) {
    const idx = stepIndex(JourneyState.step);
    const step = STEPS[idx];
    const leavingCall = step.id !== 'call';
    if (leavingCall) stopTalk();

    function progressMark(i) {
      if (i < idx) return '✓';
      if (i === idx) return '●';
      return '○';
    }

    // Horizontal 01-07 progress rail above the Frame (not a left column).
    const progress = el('nav', {
      class: 'journey-progress',
      'aria-label': 'AI Employee setup steps',
    }, STEPS.map((s, i) => el('button', {
      class: 'journey-progress-item'
        + (s.id === step.id ? ' is-active' : '')
        + (i < idx ? ' is-done' : '')
        + (i > idx ? ' is-todo' : ''),
      type: 'button',
      'aria-current': s.id === step.id ? 'step' : undefined,
      onclick: () => {
        if (JourneyState.path === 'demonstrate' && i < stepIndex('call')) {
          // Allow back into configure from demonstrate.
          JourneyState.path = 'configure';
        }
        goStep(s.id);
      },
    }, [
      el('span', {
        class: 'journey-progress-dot',
        'aria-hidden': 'true',
        html: i < idx ? icon('check') : '',
      }),
      el('span', { class: 'journey-progress-mark', 'aria-hidden': 'true' }, progressMark(i)),
      el('span', { class: 'journey-progress-num' }, '0' + (i + 1)),
      el('span', { class: 'journey-progress-label' }, s.timeline),
    ])));

    // Frame INNER icon rail stays (Employee → Next), synced to step.
    const rail = el('aside', { class: 'journey-rail' }, STEPS.map((s) => el('button', {
      class: 'journey-rail-item' + (s.id === step.id ? ' is-active' : ''),
      type: 'button',
      onclick: () => goStep(s.id),
      html: icon(s.id) + '<span>' + esc(s.label) + '</span>',
    })));

    const bodyHost = el('div', { class: 'journey-panel is-animating' });
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
          JourneyState.path = 'configure';
          JourneyState.dirtyPrompt = null;
          JourneyState.autoStartTalk = false;
          stopVoicePreview();
          stopTalk();
          saveLocal({ step: 'employee', mode: JourneyState.mode, path: 'configure' });
          try { await saveJourney({ step: 'employee', mode: JourneyState.mode }); } catch (_) {}
          toast('Journey restarted.', 'ok');
          await refresh();
          return;
        }
        await goStep(STEPS[idx + 1].id);
      },
      html: idx >= STEPS.length - 1
        ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg> Start over'
        : 'Continue',
    });

    const main = el('div', { class: 'journey-main' }, [
      el('div', { class: 'journey-top' }, [
        el('h2', {}, panelTitle(data)),
        el('div', { class: 'step-meta' }, 'Step ' + (idx + 1) + ' of 7'),
      ]),
      step.id === 'employee' ? null : null,
      bodyHost,
      el('div', { class: 'journey-footer' }, [
        idx > 0 ? back : null,
        continueBtn,
      ]),
    ]);

    const frame = el('div', { class: 'journey-chrome' }, [
      el('div', { class: 'journey-chrome-bar' }, [
        el('div', { class: 'chrome-title-row' }, [
          el('span', { class: 'chrome-title' }, chromeLabel()),
          JourneyState.mode === 'demo' ? demoBadge(true) : el('span', { class: 'journey-live-badge' }, 'LIVE'),
        ]),
        el('div', { class: 'chrome-right' }, [
          el('div', { class: 'journey-header-ctas' }, [
            el('button', {
              type: 'button',
              class: 'journey-header-cta' + (JourneyState.path === 'configure' && JourneyState.mode === 'live' ? ' is-on' : ''),
              onclick: () => startConfigure(),
            }, 'Configure Maya'),
            el('button', {
              type: 'button',
              class: 'journey-header-cta journey-header-cta-live' + (JourneyState.path === 'demonstrate' ? ' is-on' : ''),
              onclick: () => startLiveDemo(),
            }, 'Run Live Demo'),
          ]),
          el('div', { class: 'journey-mode-mini' }, [
            el('button', {
              type: 'button',
              class: JourneyState.mode === 'live' ? 'is-on' : '',
              onclick: () => setMode('live'),
            }, 'Live'),
            el('button', {
              type: 'button',
              class: JourneyState.mode === 'demo' ? 'is-on' : '',
              onclick: () => setMode('demo'),
            }, 'DEMO PREVIEW'),
          ]),
          el('span', { class: 'journey-traffic', 'aria-hidden': 'true' }, [
            el('span', { class: 'r' }), el('span', { class: 'y' }), el('span', { class: 'g' }),
          ]),
        ]),
      ]),
      el('div', { class: 'journey-shell' }, [rail, main]),
    ]);

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'journey-wrap' }, [
      progress,
      frame,
    ]));
  }

  async function viewAiEmployeeSetup(root) {
    stopTalk();
    stopVoicePreview();
    const local = loadLocal();
    JourneyState.step = local.step || 'employee';
    JourneyState.mode = local.mode || 'live';
    JourneyState.path = local.path === 'demonstrate' ? 'demonstrate' : 'configure';
    JourneyState.autoStartTalk = false;
    JourneyState.dirtyPrompt = null;

    // No extra page chrome: the Frame itself is the product surface.
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
