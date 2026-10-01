/**
 * Astra Voice. Maya WF8 node hop audit for first-response latency.
 *
 * Marks each workflow node REQUIRED_FOR_FIRST_RESPONSE YES/NO so Hostinger
 * operators can remove or defer extras that do not need to run before the
 * first audible syllable. Does not auto-write Dograh WF8.
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
      // Global policy is needed for correct behaviour, but the FULL global
      // prompt does not all need to be in the hot TTFT path. Mark YES with
      // compaction note.
      required = 'YES_COMPACT';
      defer = false;
      rationale = 'Identity + booking/end-call safety needed. Defer long qualification banks until after first phrase.';
    } else if (type === 'startCall') {
      required = 'YES';
      defer = false;
      rationale = 'Greeting / start stage can produce first audio.';
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

  return {
    employee_id: maya.MAYA_EMPLOYEE_ID,
    dograh_workflow_id: maya.MAYA_DOGRAH_WORKFLOW_ID,
    did: maya.MAYA_DID,
    tts: maya.MAYA_TTS,
    protected: true,
    nodes: rows,
    edges: edgeRows,
    hot_path_approx_tokens: hotTokens,
    recommendations: [
      'Speak booking ack before any Cal.com tool node.',
      'Do not run End Call eligibility LLM hop before first audio on booking language (use local policy).',
      'Keep Global prompt compacted for TTFT; full qualification bank can ride after first phrase.',
      'P0.2: at most one conversational LLM before first audible. Defer edge-router / language / summarizer LLMs until after first speech.',
      'NL edge conditions are LOCAL_POLICY_PREFERRED for booking. Avoid Dograh edge-router LLM before first syllable.',
      'WF8 id stays 8. Manual Hostinger import only.',
    ],
    pre_speech_llm_budget: {
      max_llm_before_first_speech: 1,
      booking_ack_llm_before_first_speech: 0,
      deferred: ['edge_router_classifier', 'language_detect_llm', 'qualification_bank_preload', 'call_summarizer'],
    },
  };
}

module.exports = {
  buildWf8NodeTrace,
};
