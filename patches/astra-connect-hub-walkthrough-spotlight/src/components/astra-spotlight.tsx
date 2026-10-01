import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/** Soft electric-blue ring shared with --astra-blue / --voice / brand #0077ec. */
export const ASTRA_SPOTLIGHT_BLUE = "#0077ec";

export type SpotlightTip = {
  /** Matches data-spotlight on the target inside the tour root. */
  id: string;
  tip: string;
};

/** Tip copy is data-driven so later edits stay copy-only. */
export const VOICE_WALKTHROUGH_TIPS: SpotlightTip[][] = [
  // 01 Create AI Employee
  [
    {
      id: "maya-profile",
      tip: "This is Maya — your AI employee. Name, team, and Ready all live here.",
    },
    {
      id: "job-box",
      tip: "One-line brief. If she only remembered one thing, it’s this.",
    },
    {
      id: "readiness",
      tip: "Her readiness strip. When these light up, she’s cleared for the floor.",
    },
    {
      id: "continue",
      tip: "Next we’ll teach her how to talk — script, knowledge, rules.",
    },
  ],
  // 02 Teach the job
  [
    {
      id: "system-prompt",
      tip: "Her job script. What she says and how she qualifies — edit here.",
    },
    {
      id: "knowledge",
      tip: "Business knowledge. Drop PDFs, FAQs, or a site so she answers from your facts.",
    },
    {
      id: "rules",
      tip: "Rules that decide who is a lead. Toggle what she must check.",
    },
    {
      id: "continue",
      tip: "Next: pick how she sounds — voice and language.",
    },
  ],
  // 03 Choose Voice & Language
  [
    {
      id: "voice-profile",
      tip: "How Maya sounds. Warm, natural, and ready for a sample listen.",
    },
    {
      id: "voice-picker",
      tip: "Pick a demo voice. Each profile is tuned for a different kind of call.",
    },
    {
      id: "language",
      tip: "Language she can speak. English plus regional options for your callers.",
    },
    {
      id: "continue",
      tip: "Next: connect a number, hours, and calendar so she can go live.",
    },
  ],
  // 04 Connect
  [
    {
      id: "number-routing",
      tip: "Her business number and routing. Who gets qualified leads after the call.",
    },
    {
      id: "hours",
      tip: "Working hours. She only dials when your team is ready to follow up.",
    },
    {
      id: "calendar",
      tip: "Calendar link. Booked demos land on the right owner’s schedule.",
    },
    {
      id: "continue",
      tip: "Next: hear a sample conversation in her voice and language.",
    },
  ],
  // 05 Conversation
  [
    {
      id: "call-header",
      tip: "Live call context. Who she’s talking to, status, and language in use.",
    },
    {
      id: "waveform",
      tip: "The call in motion. Audio presence while the conversation unfolds.",
    },
    {
      id: "transcript",
      tip: "The transcript. Maya and the caller, including regional language turns.",
    },
    {
      id: "continue",
      tip: "Next: see what she understood — structured fields from the talk.",
    },
  ],
  // 06 Structured result
  [
    {
      id: "outcome-header",
      tip: "Structured outcome. The call becomes clean customer context.",
    },
    {
      id: "pipeline",
      tip: "Conversation → understanding → outcome → next action. The path in one glance.",
    },
    {
      id: "fields",
      tip: "Extracted fields. Interest, team, timing — ready for your CRM shape.",
    },
    {
      id: "status",
      tip: "Qualification status. Green means she’s marked this lead as ready.",
    },
    {
      id: "continue",
      tip: "Next: the follow-up she recommends after the call.",
    },
  ],
  // 07 Next action
  [
    {
      id: "next-action",
      tip: "Recommended next step. Owner, timing, and what to do after the call.",
    },
    {
      id: "metrics",
      tip: "Demo metrics for this journey — calls, qualified rate, meetings booked.",
    },
    {
      id: "summary",
      tip: "Outcome summary. Regional talk, captured as English context for follow-up.",
    },
    {
      id: "continue",
      tip: "That’s the full path. Start over anytime to walk it again.",
    },
  ],
];

/** @deprecated Use VOICE_WALKTHROUGH_TIPS[0] */
export const VOICE_STEP1_SPOTLIGHTS = VOICE_WALKTHROUGH_TIPS[0]!;

const DEFAULT_DWELL_MS = 2500;

type TourState = {
  index: number;
  active: boolean;
};

/**
 * Shared spotlight tour for marketing walkthrough panels.
 * One tip + ring at a time; auto-advances; click/tap skips to next.
 * Calls onComplete once after the final tip finishes (auto or skip).
 */
export function useSpotlightTour({
  enabled,
  steps,
  dwellMs = DEFAULT_DWELL_MS,
  onComplete,
}: {
  enabled: boolean;
  steps: SpotlightTip[];
  dwellMs?: number;
  onComplete?: () => void;
}) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<TourState>({ index: 0, active: false });
  const timerRef = useRef<number | null>(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const finish = useCallback(() => {
    setState({ index: 0, active: false });
    if (!completedRef.current) {
      completedRef.current = true;
      onCompleteRef.current?.();
    }
  }, []);

  const advance = useCallback(() => {
    setState((prev) => {
      if (!prev.active) return prev;
      const next = prev.index + 1;
      if (next >= steps.length) {
        queueMicrotask(finish);
        return { index: 0, active: false };
      }
      return { index: next, active: true };
    });
  }, [steps.length, finish]);

  useEffect(() => {
    clearTimer();
    completedRef.current = false;
    if (!enabled || steps.length === 0) {
      setState({ index: 0, active: false });
      return;
    }
    setState({ index: 0, active: true });
  }, [enabled, steps, clearTimer]);

  useEffect(() => {
    clearTimer();
    if (!state.active || !enabled) return;
    // Reduced motion: keep the first tip until the user taps; no auto-advance.
    if (reduced) return clearTimer;
    timerRef.current = window.setTimeout(advance, dwellMs);
    return clearTimer;
  }, [state.active, state.index, enabled, reduced, dwellMs, advance, clearTimer]);

  const skip = useCallback(() => {
    if (!state.active) return;
    clearTimer();
    advance();
  }, [state.active, clearTimer, advance]);

  const current = state.active ? steps[state.index] ?? null : null;

  return {
    active: state.active,
    index: state.index,
    current,
    skip,
    reducedMotion: !!reduced,
    stepCount: steps.length,
  };
}

export type SpotlightProps = {
  spotlightId?: string | null | undefined;
  tourActive?: boolean | undefined;
  tip?: string | undefined;
  tipLabel?: string | undefined;
  reducedMotion?: boolean | undefined;
};

export function useSpotlightActive(
  props: SpotlightProps,
): (id: string) => boolean {
  return (id: string) => !!props.tourActive && props.spotlightId === id;
}

export function tipForId(props: SpotlightProps, id: string): string | undefined {
  return props.tourActive && props.spotlightId === id ? props.tip : undefined;
}

export function SpotlightTipBubble({
  tip,
  stepLabel,
  reducedMotion,
  placement = "below",
}: {
  tip: string;
  stepLabel?: string | undefined;
  reducedMotion?: boolean | undefined;
  placement?: "below" | "above";
}) {
  const tipId = useId();
  const below = placement === "below";
  return (
    <motion.div
      key={tip}
      role="status"
      aria-live="polite"
      aria-labelledby={tipId}
      initial={reducedMotion ? false : { opacity: 0, y: below ? 6 : -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: below ? 4 : -4, scale: 0.98 }}
      transition={{ duration: reducedMotion ? 0.01 : 0.22, ease: "easeOut" }}
      className={cn(
        "pointer-events-none absolute left-3 right-3 z-20 max-w-[280px] rounded-lg border bg-card px-3 py-2.5 text-left shadow-[0_10px_28px_rgba(15,23,41,0.12)] sm:left-auto sm:right-0",
        below ? "top-[calc(100%+10px)]" : "bottom-[calc(100%+10px)]",
      )}
      style={{ borderColor: "color-mix(in oklab, var(--astra-blue, #0077ec) 35%, transparent)" }}
    >
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--astra-blue,#0077ec)]">
        {stepLabel ?? "Tip"}
      </span>
      <p id={tipId} className="text-pretty text-xs leading-relaxed text-foreground/90 sm:text-[13px]">
        {tip}
      </p>
      <span
        aria-hidden="true"
        className={cn(
          "absolute right-6 size-3 rotate-45 border bg-card",
          below ? "-top-1.5 border-l border-t" : "-bottom-1.5 border-r border-b",
        )}
        style={{ borderColor: "color-mix(in oklab, var(--astra-blue, #0077ec) 35%, transparent)" }}
      />
    </motion.div>
  );
}

export function SpotlightTarget({
  id,
  active,
  tourActive,
  className,
  children,
  tip,
  tipLabel,
  reducedMotion,
  tipPlacement = "below",
}: {
  id: string;
  active: boolean;
  tourActive: boolean;
  className?: string | undefined;
  children: ReactNode;
  tip?: string | undefined;
  tipLabel?: string | undefined;
  reducedMotion?: boolean | undefined;
  tipPlacement?: "below" | "above";
}) {
  return (
    <div
      data-spotlight={id}
      data-spotlight-active={active ? "true" : undefined}
      className={cn(
        "relative rounded-lg transition-[opacity,box-shadow,filter] duration-300",
        tourActive && !active && "opacity-40 saturate-[0.85]",
        active && "z-10",
        className,
      )}
      style={
        active
          ? {
              boxShadow: `0 0 0 2px ${ASTRA_SPOTLIGHT_BLUE}, 0 0 0 7px color-mix(in oklab, ${ASTRA_SPOTLIGHT_BLUE} 22%, transparent)`,
            }
          : undefined
      }
    >
      {children}
      <AnimatePresence>
        {active && tip ? (
          <SpotlightTipBubble
            tip={tip}
            stepLabel={tipLabel}
            reducedMotion={reducedMotion}
            placement={tipPlacement}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Optional full-panel skip control for tours that need an explicit overlay hit-target. */
export function SpotlightSkipLayer({
  active,
  onSkip,
  label = "Show next tip",
}: {
  active: boolean;
  onSkip: () => void;
  label?: string;
}) {
  if (!active) return null;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSkip();
      }}
      className="absolute inset-0 z-30 cursor-pointer rounded-[inherit] bg-transparent"
    />
  );
}
