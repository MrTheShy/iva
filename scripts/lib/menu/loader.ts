// What the chat shows while a turn runs: the word next to the spinner, and
// whether the model's thinking is streamed alongside it.
//
// Both live in data/settings.json and are read fresh by the channel on every
// turn, so a tap applies to the next message with no restart. Same pattern as
// lang.ts.
import { writeSettings } from "#lib/settings.ts";
import {
  LOADER_STYLES,
  isLoaderStyle,
  loaderStyle,
  pickWorkingWord,
  type LoaderStyle,
} from "#lib/loader-words.ts";
import { showReasoning } from "#reasoning-bridge.ts";

type Button = { text: string; callback_data: string };
type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
  show: (state: MenuState, screen: string) => Promise<void>;
};

const LABELS: Record<LoaderStyle, string> = {
  classic: "🙂 Classico",
  fable: "✨ Fable",
  kurisu: "🧪 Kurisu",
};

export default {
  parent: "r",
  render(_st: MenuState, ctx: MenuContext) {
    const cur = loaderStyle();
    const rows = LOADER_STYLES.map((s) => [
      ctx.btn(`${LABELS[s]}${cur === s ? " ✓" : ""}`, `iva_menu:ld:set:${s}`),
    ]);
    // The toggle carries the NEXT state in its callback, not a bare "flip":
    // a stale message tapped twice would otherwise undo a change made since.
    const on = showReasoning();
    rows.push([
      ctx.btn(
        on
          ? ctx.tr("🧠 Thinking: shown", "🧠 Рассуждения: видны")
          : ctx.tr("🧠 Thinking: hidden", "🧠 Рассуждения: скрыты"),
        `iva_menu:ld:think:${on ? "0" : "1"}`,
      ),
    ]);
    rows.push(ctx.backRow("r"));
    // Show a live sample of the current style so the choice is concrete.
    const sample = pickWorkingWord();
    return {
      text: ctx.tr(
        `⏳ While I work\n\nStatus word — now: ${sample}`,
        `⏳ Пока я работаю\n\nСлово статуса — сейчас: ${sample}`,
      ),
      rows,
    };
  },
  async on(verb: string, args: string[], st: MenuState, ctx: MenuContext) {
    if (verb === "set") {
      const style = isLoaderStyle(args[0]) ? args[0] : "classic";
      writeSettings({ loaderStyle: style });
    } else if (verb === "think") {
      // Persist a real boolean: showReasoning() only honours a boolean, so a
      // stray string would silently fall back to the .env default.
      writeSettings({ showReasoning: args[0] === "1" });
    } else {
      return;
    }
    st.page = 0;
    await ctx.show(st, "ld"); // stay here so the ✓ and sample update
  },
};
