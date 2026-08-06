import { defineHook } from "eve/hooks";
import { noteForeignStep } from "../reasoning-bridge.js";

// Tells the reasoning bridge when a model step ran outside the chat, so the
// chat's collapsible never shows a background session's thinking.
//
// The rollups and the digest reach the agent through eve/client (channel kind
// "http"), which means their turns run in this process on the same wrapped
// model as a Telegram turn — see reasoning-bridge.ts. `step.completed` is the
// one signal that carries the channel kind, which is why detection lives in a
// hook and not in the middleware (the middleware has no session context).
//
// Anything that is not "telegram" counts as foreign, including an absent kind:
// the safe direction is to drop the display, not to show unattributed text.
// Inline subagent steps arrive as "subagent.event" rather than "step.completed"
// and are deliberately NOT flagged — the planner runs inside the chat turn, so
// its thinking belongs to that turn.

// No feature check: noteForeignStep() is inert unless a buffer is open, and a
// buffer only opens when the display is on.
export default defineHook({
  events: {
    "step.completed": (_event, ctx) => {
      if (ctx.channel.kind !== "telegram") noteForeignStep();
    },
  },
});
