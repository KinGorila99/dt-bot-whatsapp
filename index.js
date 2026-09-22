// Auto-reactivate the bot after an advisor has been idle.
const HUMAN_HANDOFF_IDLE_MINUTES = Math.max(5, Number(process.env.HUMAN_HANDOFF_IDLE_MINUTES || 30));

function timestampMs(value) {
  if (!value) return 0;
  const parsed = value instanceof Date ? value : new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : 0;
}

function shouldAutoReactivateBot(conversation, now = Date.now()) {
  if (!conversation || conversation.status === 'closed') return false;
  if (conversation.auto_reactivate_enabled === false) return false;
  if (conversation.human_handoff !== true && conversation.bot_enabled !== false) return false;
  const handoffStartedMs = timestampMs(conversation.last_agent_message_at || conversation.human_handoff_started_at);
  if (!handoffStartedMs) return false;
  return now - handoffStartedMs >= HUMAN_HANDOFF_IDLE_MINUTES * 60 * 1000;
}
