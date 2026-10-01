/**
 * Astra Voice. Maya WF8 node hop audit for first-response latency.
 *
 * Marks each workflow node REQUIRED_FOR_FIRST_RESPONSE YES/NO so Hostinger
 * operators can remove or defer extras that do not need to run before the
 * first audible syllable. Does not auto-write Dograh WF8.
 *
 * Also audits pre-speech Groq hops (edge routers, lang/qual/summarizer) that
 * must be deferred until after first spoken.
 *
 * No em dashes. Commas and periods only.
 */
'use strict';

const maya = require('./maya-conversation-policy');

/**
 * Build a required-for-first-response trace over the Astra-owned Maya graph.
 */
function buildWf8NodeTrace(graph) {
  const g = graph || maya.buildMayaWorkflowGraph();
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const preSpeech = (g.meta && g.meta.pre_speech_policy) || maya.PRE_SPEECH_POLICY;

  const rows = nodes.map((node) => {
    const id = String(node.id);
    const type = String(node.type || '');
    const name = String((node.data && node.data.name) || type || id);
    const prompt = String((node.data && node.data.prompt) || '');
    const addGlobal = !!(node.data && node.data.add_global_prompt);

    let required = 'NO';
    let defer = true;
    let rationale = '';

    if (type === 'globalNode') {
      // Global HOT policy is needed; full qualification bank is deferred.
      required = 'YES_COMPACT';
      defer = false;
      rationale = 'Identity + booking/end-call safety needed (HOT prompt). Defer qualification bank to Qualify stage.';
    } else if (type === 'startCall') {
      required = 'YES';
      defer = false;
      rationale = 'Greeting / start stage can produce first audio. No lang/intent classifier before speech.';
    } else if (type === 'agentNode' && /qualify/i.test(name)) {
      required = 'YES_COMPACT';
      defer = false;
      rationale = 'Qualification answers need the stage, but one question at a time. Do not preload all 4 questions into first TTS.';
    } else if (type === 'agentNode' && /book/i.test(name)) {
      required = 'ACK_ONLY';
      defer = true;
      rationale = 'First audio is booking ack only. Cal.com / availability tools MUST NOT run before first spoken.';
    } else if (type === 'endCall') {
      required = 'NO';
      defer = true;
      rationale = 'End Call never required for first response.';
    } else {
      required = 'NO';
      defer = true;
      rationale = 'Not needed before first audible response.';
    }

    return {
      node_id: id,
      type,
      name,
      required_for_first_response: required,
      defer_until_after_first_audio: defer,
      add_global_prompt: addGlobal,
      prompt_chars: prompt.length,
      approx_tokens: Math.ceil(prompt.length / 4),
      rationale,
    };
  });

  const edgeRows = edges.map((e) => ({
    edge_id: e.id,
    source: e.source,
    target: e.target,
    label: e.data && e.data.label,
    prefer_local_policy: !!(e.data && e.data.prefer_local_policy),
    // Natural-language edge routers cost an LLM decision. Prefer local policy
    // for booking vs end-call when possible to avoid an extra hop before speech.
    required_for_first_response: /book/i.test(String((e.data && e.data.label) || ''))
      ? 'LOCAL_POLICY_PREFERRED'
      : 'ROUTER_OK_AFTER_FIRST_AUDIO',
    condition_chars: String((e.data && e.data.condition) || '').length,
  }));

  const hotTokens = rows
    .filter((r) => r.required_for_first_response === 'YES' || r.required_for_first_response === 'YES_COMPACT' || r.required_for_first_response === 'ACK_ONLY')
    .reduce((n, r) => n + r.approx_tokens, 0);

  const deferredGroqHops = [
    {
      hop: 'edge_router_llm',
      defer: !!preSpeech.defer_edge_router_llm_before_first_audio,
      rationale: 'NL edge conditions must not run a Groq hop before first audible.',
    },
    {
      hop: 'language_classifier_llm',
      defer: !!preSpeech.defer_language_classifier_llm,
      rationale: 'No separate lang classifier before first speech; Maya speaks in caller language from the main turn.',
    },
    {
      hop: 'qualification_bank_preload',
      defer: !!preSpeech.defer_qualification_bank,
      rationale: 'Qualification themes live on Qualify stage; do not preload into hot TTFT.',
    },
    {
      hop: 'summarizer_llm',
      defer: !!preSpeech.defer_summarizer_llm,
      rationale: 'Summarizer is a later-turn concern, not first audio.',
    },
    {
      hop: 'end_call_eligibility_llm',
      defer: !!preSpeech.defer_end_call_eligibility_llm,
      rationale: 'Use local hangup/booking policy instead of an LLM hop before speech.',
    },
    {
      hop: 'calcom_tools',
      defer: !!preSpeech.defer_calcom_tools,
      rationale: 'Tools stay background after spoken ack.',
    },
  ];

  return {
    employee_id: maya.MAYA_EMPLOYEE_ID,
    dograh_workflow_id: maya.MAYA_DOGRAH_WORKFLOW_ID,
    did: maya.MAYA_DID,
    tts: maya.MAYA_TTS,
    protected: true,
    nodes: rows,
    edges: edgeRows,
    hot_path_approx_tokens: hotTokens,
    pre_speech_policy: preSpeech,
    deferred_pre_speech_groq_hops: deferredGroqHops,
    recommendations: [
      'Speak booking ack before any Cal.com tool node.',
      'Do not run End Call eligibility LLM hop before first audio on booking language (use local policy).',
      'Keep Global HOT prompt for TTFT; qualification bank rides on Qualify after first phrase.',
      'Defer edge-router / lang / summarizer Groq hops until after first spoken.',
      'WF8 id stays 8. Manual Hostinger import only.',
    ],
  };
}

module.exports = {
  buildWf8NodeTrace,
};
