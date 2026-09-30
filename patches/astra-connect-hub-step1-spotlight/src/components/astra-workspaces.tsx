import gsap from "gsap";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Activity, BarChart3, BookOpen, BriefcaseBusiness, CalendarDays, Check, CheckCheck, Clock, FileText,
  IndianRupee, Languages, ListChecks, MessageCircle, Mic2, MoreHorizontal, Paperclip, Pause, Phone, PhoneForwarded, Play,
  Send, Settings, Sparkles, Tag, UserRound, UsersRound, Video, X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ProductLogo } from "@/components/astra-site";
import {
  SpotlightTarget,
  VOICE_STEP1_SPOTLIGHTS,
  useSpotlightTour,
} from "@/components/astra-spotlight";

function Frame({ children, label, allowOverflow = false }: { children: ReactNode; label: string; allowOverflow?: boolean }) {
  return <div className={cn("rounded-lg border border-border bg-card shadow-panel", allowOverflow ? "overflow-visible" : "overflow-hidden")}><div className="grid grid-cols-[minmax(0,1fr)_auto] items-center border-b border-border px-4 py-2 text-xs text-muted-foreground"><span className="truncate">{label}</span><span className="flex gap-1.5" aria-hidden="true"><i className="size-2 rounded-full bg-destructive"/><i className="size-2 rounded-full bg-warning"/><i className="size-2 rounded-full bg-success"/></span></div>{children}</div>;
}

/* ---------------- Astra Chat ---------------- */

type Status = "sent" | "delivered" | "read";
type Msg = { id: number; from: "them" | "me"; text: string; time: string; status?: Status };

const people = [
  { initials: "AM", name: "Arjun Mehta", company: "Acme Retail", phone: "+91 98765 43210", note: "Can we arrange a demo?", time: "11:24", value: "₹4,80,000", stage: "Qualified", tags: ["Hot lead", "Retail", "Demo requested"],
    thread: [
      { id: 1, from: "them", text: "Hi! I’d like to see how AstraConnect works for our 12-person sales team.", time: "11:02" },
      { id: 2, from: "me", text: "Happy to help, Arjun. Are most of your enquiries coming in on WhatsApp today?", time: "11:05", status: "read" },
      { id: 3, from: "them", text: "Yes, around 200 a week. We lose track after the first reply.", time: "11:18" },
      { id: 4, from: "them", text: "Can we arrange a demo?", time: "11:24" },
    ] as Msg[],
    activity: [["Demo requested on WhatsApp", "11:24"], ["Moved to Qualified by Ananya", "11:10"], ["Astra Voice call · 4m 12s", "Yesterday"], ["Lead created from website form", "Mon"]] },
  { initials: "PS", name: "Priya Sharma", company: "Nimbus Health", phone: "+91 99012 22110", note: "Thanks for the details!", time: "10:41", value: "₹2,10,000", stage: "Proposal", tags: ["Healthcare", "Pricing sent"],
    thread: [
      { id: 1, from: "me", text: "Hi Priya, sharing the pricing sheet we discussed.", time: "10:30", status: "read" },
      { id: 2, from: "them", text: "Thanks for the details!", time: "10:41" },
    ] as Msg[],
    activity: [["Proposal sent", "10:30"], ["Call booked", "Tue"]] },
  { initials: "RV", name: "Rahul Verma", company: "Fieldline Logistics", phone: "+91 90040 55123", note: "When can we get started?", time: "09:18", value: "₹6,50,000", stage: "Contacted", tags: ["Logistics", "Enterprise"],
    thread: [
      { id: 1, from: "them", text: "When can we get started?", time: "09:18" },
    ] as Msg[],
    activity: [["Replied to outreach", "09:18"], ["Outreach sent", "Yesterday"]] },
];

const guideSuggestions: Record<number, { hint: string; reply: string; action: string }[]> = {
  0: [
    { hint: "Offer two demo slots", reply: "Great — I can show you on Thursday at 11:00 or Friday at 15:00. Which suits your team?", action: "Propose slots" },
    { hint: "Qualify team size & tools", reply: "Before the demo, which CRM are you using today, and who else should join?", action: "Ask to qualify" },
  ],
  1: [{ hint: "Check if pricing is clear", reply: "Glad it helped, Priya! Any questions on the Growth plan before we finalise?", action: "Follow up" }],
  2: [{ hint: "Send onboarding next steps", reply: "We can start this week. I’ll send a 15-minute kickoff invite — does tomorrow work?", action: "Suggest kickoff" }],
};

function Ticks({ status }: { status?: Status | undefined }) {
  if (!status) return null;
  const label = status === "read" ? "Read" : status === "delivered" ? "Delivered" : "Sent";
  return <span aria-label={label} title={label} className={cn("inline-flex", status === "read" ? "text-voice" : "text-muted-foreground")}>{status === "sent" ? <Check className="size-3.5"/> : <CheckCheck className="size-3.5"/>}</span>;
}

export function ChatWorkspace() {
  const [selected, setSelected] = useState(0);
  const [threads, setThreads] = useState(() => people.map((p) => p.thread));
  const [stages, setStages] = useState(() => people.map((p) => p.stage));
  const [draft, setDraft] = useState("");
  const [guideOpen, setGuideOpen] = useState(true);
  const [suggestion, setSuggestion] = useState(0);
  const [view, setView] = useState("Inbox");
  const [notes, setNotes] = useState<Record<number, string[]>>({});
  const [newNote, setNewNote] = useState("");
  const [extraTags, setExtraTags] = useState<Record<number, string[]>>({});
  const timers = useRef<number[]>([]);
  const reduce = useReducedMotion();
  const person = people[selected]!;
  const thread = threads[selected] ?? [];
  const tips = guideSuggestions[selected] ?? [];
  const tip = tips[suggestion % Math.max(1, tips.length)];
  const nav = [{ Icon: MessageCircle, label: "Inbox" }, { Icon: UsersRound, label: "Contacts" }, { Icon: BriefcaseBusiness, label: "Deals" }, { Icon: BarChart3, label: "Analytics" }, { Icon: Settings, label: "Settings" }];

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const send = (text: string) => {
    if (!text.trim()) return;
    const id = Date.now();
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const idx = selected;
    const setStatus = (status: Status) => setThreads((all) => all.map((t, i) => i !== idx ? t : t.map((m) => m.id === id ? { ...m, status } : m)));
    setThreads((all) => all.map((t, i) => i === idx ? [...t, { id, from: "me", text, time, status: "sent" }] : t));
    setDraft("");
    timers.current.push(window.setTimeout(() => setStatus("delivered"), reduce ? 0 : 900), window.setTimeout(() => setStatus("read"), reduce ? 0 : 2200));
  };

  return <>
    <Frame label="Astra Chat · WhatsApp workspace (sample data)">
      <div className="grid md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[150px_220px_minmax(0,1fr)_260px]">
        <aside className="hidden border-r border-border p-4 xl:block"><ProductLogo product="chat" className="h-9"/><div className="mt-7 grid gap-1 text-sm">{nav.map(({ Icon, label }) => <button type="button" key={label} aria-pressed={view===label} onClick={()=>setView(label)} className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", view === label ? "bg-chat-soft text-chat-dark" : "hover:bg-secondary")}><Icon className="size-4"/>{label}</button>)}</div></aside>

        <div className="border-b border-border p-3 md:border-b-0 md:border-r">
          <Tabs defaultValue="all"><TabsList className="w-full"><TabsTrigger value="all">All</TabsTrigger><TabsTrigger value="mine">Mine</TabsTrigger><TabsTrigger value="unread">Unread</TabsTrigger></TabsList></Tabs>
          <div className="mt-2 grid gap-1">{people.map((c, i) => <button key={c.name} type="button" onClick={() => { setSelected(i); setSuggestion(0); setGuideOpen(true); }} aria-pressed={selected === i} className={cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected === i ? "bg-chat-soft" : "hover:bg-secondary")}><span className="grid size-9 place-items-center rounded-full bg-chat/15 text-xs font-medium">{c.initials}</span><span className="min-w-0"><b className="block truncate text-xs">{c.name}</b><span className="block truncate text-[11px] text-muted-foreground">{(threads[i] ?? []).at(-1)?.text ?? c.note}</span></span><span className="self-start text-[10px] tabular-nums text-muted-foreground">{c.time}</span></button>)}</div>
        </div>

        <section className="flex min-h-[520px] flex-col border-border xl:border-r" aria-label={`Conversation with ${person.name}`}>
          <header className="flex items-center gap-3 border-b border-border px-4 py-3"><span className="grid size-9 place-items-center rounded-full bg-chat/15 text-xs font-medium">{person.initials}</span><div className="min-w-0"><b className="block truncate text-sm">{person.name}</b><span className="text-[11px] text-chat-dark">online</span></div><span className="ml-auto flex gap-3 text-muted-foreground"><Video className="size-4"/><Phone className="size-4"/><MoreHorizontal className="size-4"/></span></header>
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto bg-chat-soft/40 p-4 text-sm">
            <span className="mx-auto rounded-full bg-card px-3 py-1 text-[10px] text-muted-foreground">Today</span>
            <AnimatePresence initial={false}>{thread.map((m) => <motion.div key={m.id} layout={!reduce} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={cn("max-w-[78%] rounded-lg px-3 py-2 shadow-sm", m.from === "me" ? "ml-auto rounded-br-sm bg-chat-soft" : "rounded-bl-sm bg-card")}><p className="text-pretty">{m.text}</p><span className="mt-1 flex items-center justify-end gap-1 text-[10px] tabular-nums text-muted-foreground">{m.time}<Ticks status={m.status}/></span></motion.div>)}</AnimatePresence>
          </div>

          <div className="relative border-t border-border p-3">
            <AnimatePresence>{guideOpen && tip && <motion.div initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }} className="mb-3 rounded-lg border border-guide-border bg-guide p-3 text-guide-foreground shadow-guide" role="region" aria-label="Astra Guide suggestion">
              <div className="flex items-center gap-2 text-xs"><span className="grid size-6 place-items-center rounded-full border border-voice border-r-chat"><Sparkles className="size-3"/></span><b>Astra Guide</b><span className="text-guide-muted">· {tip.hint}</span><span className="ml-auto rounded-full bg-chat/15 px-2 py-0.5 text-[10px] text-chat">92% confident</span><button type="button" onClick={() => setGuideOpen(false)} aria-label="Dismiss suggestion" className="rounded p-0.5 hover:bg-guide-border"><X className="size-3.5"/></button></div>
              <p className="mt-2 text-sm text-guide-foreground/90">“{tip.reply}”</p>
              <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" className="h-8 bg-chat hover:bg-chat/90" onClick={() => send(tip.reply)}><Send/> {tip.action}</Button><Button size="sm" variant="outline" className="h-8 border-guide-border bg-transparent text-guide-foreground hover:bg-guide-border hover:text-guide-foreground" onClick={() => setDraft(tip.reply)}>Edit first</Button>{tips.length > 1 && <Button size="sm" variant="ghost" className="h-8 text-guide-muted hover:bg-guide-border hover:text-guide-foreground" onClick={() => setSuggestion((s) => s + 1)}>Another idea</Button>}<Button size="sm" variant="ghost" className="h-8 text-guide-muted hover:bg-guide-border hover:text-guide-foreground" onClick={() => setStages((s) => s.map((v, i) => i === selected ? "Proposal" : v))}><CalendarDays/> Book & advance</Button></div>
            </motion.div>}</AnimatePresence>
            {!guideOpen && <button type="button" onClick={() => setGuideOpen(true)} className="mb-2 flex items-center gap-1.5 text-xs font-medium text-chat-dark"><Sparkles className="size-3.5"/> Ask Astra Guide</button>}
            <form className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-input bg-background px-2 py-1" onSubmit={(e) => { e.preventDefault(); send(draft); }}><Paperclip className="size-4 text-muted-foreground"/><Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-9 border-0 shadow-none focus-visible:ring-0" placeholder="Type a message…" aria-label="Message"/><Button size="icon" className="size-8 bg-chat hover:bg-chat/90" aria-label="Send message"><Send/></Button></form>
          </div>
        </section>

        <aside className="border-t border-border p-4 md:col-span-2 xl:col-span-1 xl:border-t-0">
          <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Customer details</h3><span className="text-[10px] text-muted-foreground">LOCAL DEMO</span></div>
          <div className="mt-4 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-full bg-chat/15 text-sm font-medium">{person.initials}</span><div className="min-w-0"><b className="block truncate text-sm">{person.name}</b><p className="text-xs text-muted-foreground">{person.company}</p><p className="text-xs tabular-nums text-muted-foreground">{person.phone}</p></div></div>
          <div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-md border border-border p-2.5"><p className="flex items-center gap-1 text-[10px] text-muted-foreground"><IndianRupee className="size-3"/> Deal value</p><b className="mt-1 block text-sm tabular-nums">{person.value}</b></div><div className="rounded-md border border-border p-2.5"><p className="flex items-center gap-1 text-[10px] text-muted-foreground"><UserRound className="size-3"/> Owner</p><b className="mt-1 block text-sm">Ananya</b></div></div>
          <label className="mt-4 grid gap-1.5 text-xs font-medium">Deal stage<select value={stages[selected]} onChange={(e) => setStages((s) => s.map((v, i) => i === selected ? e.target.value : v))} className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{["New lead", "Contacted", "Qualified", "Proposal", "Won"].map((o) => <option key={o}>{o}</option>)}</select></label>
          <p className="mt-4 flex items-center gap-1.5 text-xs font-medium"><Tag className="size-3.5"/> Tags</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{[...person.tags,...(extraTags[selected]??[])].map((t) => <span key={t} className="rounded-full bg-chat-soft px-2 py-0.5 text-[11px] text-chat-dark">{t}</span>)}<button type="button" onClick={()=>setExtraTags((all)=>({...all,[selected]:[...(all[selected]??[]),`Follow-up ${(all[selected]?.length??0)+1}`]}))} className="rounded-full border border-border px-2 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">+ Add tag</button></div>
          <form className="mt-4" onSubmit={(e)=>{e.preventDefault();if(!newNote.trim())return;setNotes((all)=>({...all,[selected]:[...(all[selected]??[]),newNote.trim()]}));setNewNote("");}}><label className="text-xs font-medium">Internal note<Input value={newNote} onChange={(e)=>setNewNote(e.target.value)} className="mt-1.5 h-9" placeholder="Add context for your team"/></label><Button size="sm" variant="outline" className="mt-2" disabled={!newNote.trim()}>Add note</Button></form>
          {(notes[selected]??[]).map((note)=><p key={note} className="mt-2 rounded-md bg-surface p-2 text-xs">{note}</p>)}
          <p className="mt-5 flex items-center gap-1.5 text-xs font-medium"><Activity className="size-3.5"/> Activity</p>
          <ol className="mt-2 border-l border-border pl-3">{person.activity.map(([label, when]) => <li key={label} className="relative pb-3 text-xs"><i className="absolute -left-[17px] top-1 size-2 rounded-full bg-chat"/><span className="block">{label}</span><span className="text-[10px] text-muted-foreground">{when}</span></li>)}</ol>
        </aside>
      </div>
    </Frame>
    <ChatPipeline stage={stages[selected] ?? "Qualified"}/>
  </>;
}

function ChatPipeline({ stage }: { stage: string }) {
  const steps = ["New lead", "Contacted", "Qualified", "Proposal", "Won"];
  const current = Math.max(0, steps.indexOf(stage));
  return <div className="mt-8" data-guide-title="Pipeline" data-guide-description="Track where this customer sits in your sales process." data-guide-action="Show the pipeline" data-guide="Track where this customer sits in your sales process." data-guide-tone="chat"><div className="grid grid-cols-5 gap-1" aria-label={`Pipeline stage: ${stage}`}>{steps.map((label, index) => <div key={label} className="text-center"><div className={cn("mx-auto grid size-7 place-items-center rounded-full border-2 bg-background", index <= current ? "border-chat text-chat" : "border-border text-muted-foreground")}>{index < current ? <Check className="size-4"/> : <span className="size-2 rounded-full bg-current"/>}</div><div className={cn("mt-2 h-1 rounded-full", index <= current ? "bg-chat" : "bg-border")}/><p className="mt-2 text-[10px] sm:text-xs">{label}</p></div>)}</div><p className="mt-3 text-center text-[11px] text-muted-foreground">Illustrative demo · changes stay in this preview</p></div>;
}

/* ---------------- Astra Voice ---------------- */

const voices = [{ id: "maya", name: "Maya", tone: "Lead qualification · Demo voice" }, { id: "dev", name: "Dev", tone: "Customer support · Demo voice" }, { id: "sara", name: "Sara", tone: "Appointments · Demo voice" }];

const languageChips = [
  { id: "en", label: "English", status: "ready" as const },
  { id: "hi", label: "Hindi", status: "preview" as const },
  { id: "te", label: "Telugu", status: "preview" as const },
  { id: "ta", label: "Tamil", status: "preview" as const },
];

function Row({ Icon, title, children }: { Icon: typeof Phone; title: string; children: ReactNode }) {
  return <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 py-3.5"><Icon className="mt-0.5 size-5 text-voice"/><div><b className="text-sm">{title}</b><div className="mt-1 text-sm text-muted-foreground">{children}</div></div></div>;
}

function Toggle({ label, defaultOn = true }: { label: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return <button type="button" role="switch" aria-checked={on} onClick={() => setOn(!on)} className="flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span>{label}</span><span className={cn("relative h-5 w-9 rounded-full transition-colors", on ? "bg-voice" : "bg-border")}><i className={cn("absolute top-0.5 size-4 rounded-full bg-background transition-all", on ? "left-[18px]" : "left-0.5")}/></span></button>;
}

function StepCreate({
  spotlightId,
  tourActive,
  tip,
  tipLabel,
  reducedMotion,
}: {
  spotlightId?: string | null | undefined;
  tourActive?: boolean | undefined;
  tip?: string | undefined;
  tipLabel?: string | undefined;
  reducedMotion?: boolean | undefined;
}) {
  const active = (id: string) => tourActive && spotlightId === id;
  const tipFor = (id: string) => (active(id) ? tip : undefined);
  return <div className={cn("space-y-5", tourActive && "space-y-14 pb-4")}>
    <SpotlightTarget id="maya-profile" active={!!active("maya-profile")} tourActive={!!tourActive} tip={tipFor("maya-profile")} tipLabel={tipLabel} reducedMotion={reducedMotion}>
      <div className="flex items-center gap-4 rounded-lg border border-border p-4"><span className="grid size-14 place-items-center rounded-full bg-voice/10 text-2xl font-bold text-voice">M</span><div className="min-w-0"><h4 className="text-xl font-bold">Maya</h4><p className="text-sm text-muted-foreground">Lead qualification · Sales team</p></div><span className="ml-auto flex items-center gap-1 text-sm text-success"><i className="size-2 rounded-full bg-success"/> Ready</span></div>
    </SpotlightTarget>
    <SpotlightTarget id="job-box" active={!!active("job-box")} tourActive={!!tourActive} tip={tipFor("job-box")} tipLabel={tipLabel} reducedMotion={reducedMotion}>
      <div className="rounded-lg border border-border p-4"><p className="text-sm font-semibold">Job</p><p className="mt-1 text-sm text-muted-foreground">Qualify new enquiries and identify the next step.</p></div>
    </SpotlightTarget>
    <SpotlightTarget id="readiness" active={!!active("readiness")} tourActive={!!tourActive} tip={tipFor("readiness")} tipLabel={tipLabel} reducedMotion={reducedMotion} tipPlacement="above">
      <div className="grid gap-2 sm:grid-cols-3">{["Instructions ready","Knowledge added","Outcome fields set"].map((x)=><div key={x} className="rounded-md border border-border bg-voice-soft/40 p-3 text-sm font-semibold">{x}</div>)}</div>
    </SpotlightTarget>
  </div>;
}

function StepTeach() {
  return <div className="space-y-5">
    <label className="grid gap-1.5 text-sm font-semibold">System prompt<textarea defaultValue={"You are Maya, a friendly sales assistant for Astra. Understand the caller’s team size, current tools and timeline. Be concise, never pushy, and always offer a demo when the lead qualifies."} rows={4} className="rounded-md border border-input bg-background p-3 text-sm font-normal leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"/></label>
    <div><p className="flex items-center gap-1.5 text-sm font-semibold"><BookOpen className="size-4 text-voice"/> Business knowledge</p><div className="mt-2 grid gap-2 sm:grid-cols-3">{[["Pricing guide.pdf", "12 pages"], ["Product FAQ", "48 answers"], ["astra.com", "Synced daily"]].map(([n, m]) => <div key={n} className="rounded-md border border-border p-3 text-sm"><FileText className="size-4 text-muted-foreground"/><b className="mt-2 block truncate">{n}</b><span className="text-xs text-muted-foreground">{m}</span></div>)}</div></div>
    <div><p className="flex items-center gap-1.5 text-sm font-semibold"><ListChecks className="size-4 text-voice"/> Qualification rules</p><div className="mt-2 grid gap-2"><Toggle label="Team size is 5 or more"/><Toggle label="Budget confirmed this quarter"/><Toggle label="Decision maker on the call" defaultOn={false}/></div></div>
  </div>;
}

function StepVoiceLanguage() {
  const [lang, setLang] = useState("te");
  const [voiceId, setVoiceId] = useState("maya");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  useEffect(() => { if (!playing) return; const t = window.setInterval(() => setProgress((p) => { if (p >= 100) { setPlaying(false); return 0; } return p + 4; }), 120); return () => clearInterval(t); }, [playing]);
  const v = voices.find((x) => x.id === voiceId)!;
  return <div className="space-y-5">
    <div className="rounded-lg border border-voice/30 bg-voice-soft p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.12em] text-voice"><Mic2 className="size-3.5"/> VOICE</p>
      <b className="mt-2 block text-lg">Warm · Natural · Indian English</b>
      <p className="mt-1 text-sm text-muted-foreground">Demo voice profile for Maya — illustrative sample.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">{voices.map((x) => <button key={x.id} type="button" aria-pressed={voiceId === x.id} onClick={() => { setVoiceId(x.id); setProgress(0); setPlaying(false); }} className={cn("rounded-md border p-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", voiceId === x.id ? "border-voice bg-card" : "border-border bg-card/70 hover:bg-card")}><b className="flex items-center gap-1.5">{voiceId === x.id && <Check className="size-3.5 text-voice"/>}{x.name}</b><span className="text-xs text-muted-foreground">{x.tone}</span></button>)}</div>
      <div className="mt-3 flex items-center gap-3 rounded-md border border-border bg-card p-3"><Button size="icon" className="size-10 shrink-0 rounded-full bg-voice hover:bg-voice/90" aria-label={playing ? "Pause sample" : "Play voice sample"} onClick={() => setPlaying(!playing)}>{playing ? <Pause/> : <Play/>}</Button><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">“Hi, this is {v.name} from Astra. Is now a good time?”</p><div className="mt-2 flex h-5 items-end gap-[3px]" aria-hidden="true">{Array.from({ length: 28 }, (_, i) => <i key={i} className={cn("w-1 rounded-full", i / 28 * 100 < progress ? "bg-voice" : "bg-voice/25")} style={{ height: `${6 + ((i * 7) % 16)}px` }}/>)}</div></div></div>
    </div>
    <div className="rounded-lg border border-border p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.12em] text-muted-foreground"><Languages className="size-3.5 text-voice"/> LANGUAGE</p>
      <b className="mt-2 block text-lg">Regional language ready</b>
      <p className="mt-1 text-sm text-muted-foreground">Speak to customers in English and selected regional languages.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {languageChips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            aria-pressed={lang === chip.id}
            onClick={() => setLang(chip.id)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              lang === chip.id ? "border-voice bg-voice text-voice-foreground shadow-[0_8px_18px_color-mix(in_oklab,var(--voice)_25%,transparent)]" : "border-border bg-card text-muted-foreground hover:bg-secondary",
            )}
          >
            {chip.label}
            {chip.status === "preview" && lang !== chip.id && <span className="ml-1.5 text-[10px] font-medium opacity-70">Demo preview</span>}
            {chip.status === "preview" && lang === chip.id && <span className="ml-1.5 text-[10px] font-medium opacity-90">Demo preview</span>}
          </button>
        ))}
      </div>
      {lang === "te" && (
        <p className="mt-3 rounded-md bg-voice-soft px-3 py-2 text-xs font-medium text-voice">Telugu selected for this illustrative demo · outcome fields stay in English.</p>
      )}
    </div>
  </div>;
}

function StepConnect() {
  const days = ["M", "T", "W", "T", "F", "S", "S"];
  const [active, setActive] = useState([true, true, true, true, true, false, false]);
  const [outlook,setOutlook]=useState(false);
  return <div className="space-y-5">
    <div className="divide-y divide-border rounded-lg border border-border px-4">
      <Row Icon={Phone} title="Business number"><span className="tabular-nums">+91 80 4718 2200</span> · Inbound & outbound</Row>
      <Row Icon={PhoneForwarded} title="Routing">Qualified → Ananya (Sales) · Support questions → Help desk · After hours → Voicemail + WhatsApp follow-up</Row>
    </div>
    <div><p className="flex items-center gap-1.5 text-sm font-semibold"><Clock className="size-4 text-voice"/> Working hours · 09:00 – 19:00 IST</p><div className="mt-2 flex gap-1.5">{days.map((d, i) => <button key={i} type="button" aria-pressed={active[i]} aria-label={`Toggle ${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}`} onClick={() => setActive((a) => a.map((v, j) => j === i ? !v : v))} className={cn("grid size-9 place-items-center rounded-md border text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active[i] ? "border-voice bg-voice text-voice-foreground" : "border-border text-muted-foreground")}>{d}</button>)}</div></div>
    <div><p className="flex items-center gap-1.5 text-sm font-semibold"><CalendarDays className="size-4 text-voice"/> Calendar</p><div className="mt-2 grid gap-2 sm:grid-cols-2"><div className="flex items-center justify-between rounded-md border border-voice/40 bg-voice-soft p-3 text-sm"><span>Configured calendar</span><span className="flex items-center gap-1 text-xs text-success"><Check className="size-3.5"/> Connected</span></div><div className="flex items-center justify-between rounded-md border border-border p-3 text-sm"><span>Second calendar</span><Button size="sm" variant="outline" className="h-7" onClick={()=>setOutlook((v)=>!v)}>{outlook?<><Check/> Connected</>:"Connect"}</Button></div></div><p className="mt-2 text-[11px] text-muted-foreground">Illustrative setup · no external account is connected.</p></div>
  </div>;
}

function StepConversation() {
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
      <div>
        <p className="eyebrow text-voice">LIVE CALL</p>
        <h4 className="mt-1 text-xl font-bold">Arjun Mehta</h4>
        <p className="text-sm text-muted-foreground">New enquiry · Product demo</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="rounded-full bg-voice-soft px-2.5 py-1 text-xs font-bold text-voice">Connected</span>
        <span className="rounded-full bg-foreground px-2.5 py-1 text-xs font-bold text-background">02:18</span>
        <span className="rounded-full border border-voice/30 bg-voice-soft px-2.5 py-1 text-xs font-semibold text-voice">Telugu · Demo preview</span>
      </div>
    </div>
    <div className="flex h-10 items-center gap-1 rounded-md border border-voice/15 bg-voice-soft px-3" aria-hidden="true">
      {[28,54,78,42,90,62,36,70,48,84,58,34,76,50,66,40,88,52,30,72].map((h,i)=><i key={i} className="w-[3px] rounded-full bg-voice" style={{height:`${h}%`}}/>)}
    </div>
    <div className="space-y-2.5 text-sm leading-relaxed">
      <div className="rounded-xl border border-voice/20 bg-voice-soft p-3"><p className="text-[11px] font-bold tracking-wide text-voice">MAYA</p><p className="mt-1">Hello Arjun, I’m calling regarding your enquiry.</p></div>
      <div className="rounded-xl border border-voice/20 bg-voice-soft p-3"><p className="text-[11px] font-bold tracking-wide text-voice">MAYA · TELUGU</p><p className="mt-1">మీకు తెలుగు లో మాట్లాడటం సౌకర్యంగా ఉంటుందా?</p></div>
      <div className="ml-auto max-w-[92%] rounded-xl border border-border bg-card p-3"><p className="text-[11px] font-bold tracking-wide text-muted-foreground">ARJUN</p><p className="mt-1">Yes, <mark className="rounded bg-voice/15 px-1 font-semibold text-voice">Telugu</mark> is fine.</p></div>
      <div className="rounded-xl border border-voice/20 bg-voice-soft p-3"><p className="text-[11px] font-bold tracking-wide text-voice">MAYA · TELUGU</p><p className="mt-1">సరే. మీకు ఏ విషయం గురించి సమాచారం కావాలి?</p></div>
      <div className="ml-auto max-w-[92%] rounded-xl border border-border bg-card p-3"><p className="text-[11px] font-bold tracking-wide text-muted-foreground">ARJUN</p><p className="mt-1">We need a <mark className="rounded bg-voice/15 px-1 font-semibold text-voice">product demo</mark> for our <mark className="rounded bg-voice/15 px-1 font-semibold text-voice">sales team</mark> — <mark className="rounded bg-voice/15 px-1 font-semibold text-voice">this week</mark> works.</p></div>
    </div>
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="rounded-full bg-voice-soft px-2 py-0.5 font-semibold text-voice">Regional language</span> Conversation continues in Telugu + English · illustrative demo</p>
  </div>;
}

function StepStructuredResult() {
  return <div className="space-y-4">
    <div>
      <p className="eyebrow text-voice">STRUCTURED OUTCOME</p>
      <h4 className="mt-1 text-xl font-bold">Customer context</h4>
      <p className="mt-1 text-sm text-muted-foreground">Normalized English fields from the multilingual call.</p>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
      <span className="text-voice">Conversation</span><span className="h-px w-4 bg-voice/40"/><span>Understanding</span><span className="h-px w-4 bg-voice/40"/><span>Outcome</span><span className="h-px w-4 bg-voice/40"/><span>Next action</span>
    </div>
    <div className="grid gap-2">
      {[["INTEREST","Product demo","from “product demo”"],["TEAM","Sales","from “sales team”"],["TIMING","This week","from “this week”"]].map(([k,v,f])=>(
        <div key={k} className="rounded-xl border border-voice/30 bg-voice-soft px-4 py-3">
          <p className="text-[10px] font-bold tracking-[0.12em] text-muted-foreground">{k}</p>
          <b className="mt-1 block text-base">{v}</b>
          <p className="mt-1 text-xs font-medium text-voice">{f}</p>
        </div>
      ))}
    </div>
    <div className="rounded-xl border border-success/30 bg-success/10 px-4 py-3">
      <p className="text-[10px] font-bold tracking-[0.12em] text-success">STATUS</p>
      <b className="mt-1 block text-lg text-success">Qualified</b>
    </div>
  </div>;
}

function StepNextAction() {
  return <div className="space-y-5">
    <div className="rounded-xl border border-voice/30 bg-voice-soft p-4">
      <p className="text-[10px] font-bold tracking-[0.12em] text-voice">NEXT ACTION</p>
      <b className="mt-2 block text-xl">Schedule sales follow-up</b>
      <p className="mt-1 text-sm text-muted-foreground">Owner Ananya · Demo this week</p>
    </div>
    <div className="grid gap-2 sm:grid-cols-3">{[["128", "Calls"], ["46%", "Qualified"], ["38", "Meetings"]].map(([v, l]) => <div key={l} className="rounded-md border border-border p-3"><b className="block text-2xl tabular-nums">{v}</b><span className="text-xs text-muted-foreground">{l}</span></div>)}</div>
    <div className="rounded-lg border border-voice/30 bg-voice-soft p-4 text-sm"><p className="flex items-center gap-1.5 font-semibold"><Sparkles className="size-4 text-voice"/> Outcome summary</p><p className="mt-1.5 text-pretty text-muted-foreground">Regional-language call captured as structured English context — ready for Chat follow-up or CRM.</p></div>
    <p className="text-[11px] text-muted-foreground">Illustrative demo · language support shown as Demo preview.</p>
  </div>;
}

export function VoiceWorkspace() {
  const steps = [
    "Create AI Employee",
    "Teach the job",
    "Choose Voice & Language",
    "Connect",
    "Conversation",
    "Structured result",
    "Next action",
  ];
  const titles = [
    "Your AI employee",
    "Teach Maya the job",
    "Voice & language",
    "Connect customers",
    "Live conversation",
    "Structured result",
    "Next action",
  ];
  const [step, setStep] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const stepCount = steps.length;
  const step1Tour = useSpotlightTour({
    enabled: step === 0,
    steps: VOICE_STEP1_SPOTLIGHTS,
  });
  const tipLabel = step1Tour.active
    ? `Tip ${step1Tour.index + 1} of ${step1Tour.stepCount}`
    : undefined;
  const screens = [
    <StepCreate
      key="c"
      spotlightId={step1Tour.current?.id}
      tourActive={step1Tour.active}
      tip={step1Tour.current?.tip}
      tipLabel={tipLabel}
      reducedMotion={step1Tour.reducedMotion}
    />,
    <StepTeach key="t"/>,
    <StepVoiceLanguage key="vl"/>,
    <StepConnect key="n"/>,
    <StepConversation key="conv"/>,
    <StepStructuredResult key="sr"/>,
    <StepNextAction key="na"/>,
  ];
  useEffect(() => { if (!barRef.current) return; if (reduced) { barRef.current.style.transform = `scaleY(${(step + 1) / stepCount})`; return; } gsap.to(barRef.current, { scaleY: (step + 1) / stepCount, duration: 0.5, ease: "power3.out" }); }, [step, reduced, stepCount]);
  const side = [
    { Icon: UserRound, label: "Employee", idx: 0 },
    { Icon: BookOpen, label: "Knowledge", idx: 1 },
    { Icon: Languages, label: "Language", idx: 2 },
    { Icon: Phone, label: "Routing", idx: 3 },
    { Icon: Mic2, label: "Call", idx: 4 },
    { Icon: FileText, label: "Outcome", idx: 5 },
    { Icon: BarChart3, label: "Next", idx: 6 },
  ];
  const continueSpotlight = step === 0 && step1Tour.active && step1Tour.current?.id === "continue";
  return <div className="grid items-start gap-8 lg:grid-cols-[.72fr_1.28fr]">
    <div className="relative pl-7"><div className="absolute bottom-3 left-[7px] top-3 w-px bg-border"><div ref={barRef} className="h-full origin-top bg-voice" style={{ transform: `scaleY(${1 / stepCount})` }}/></div>{steps.map((label, index) => <button key={label} type="button" aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)} className={cn("relative mb-2 flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", step === index ? "bg-voice-soft font-semibold" : "text-muted-foreground hover:bg-secondary")}><span className={cn("absolute -left-[27px] grid size-4 place-items-center rounded-full border bg-background", step >= index && "border-voice bg-voice text-voice-foreground")}>{step > index && <Check className="size-3"/>}</span><span className="text-sm tabular-nums">0{index + 1}</span><span className="text-sm leading-snug">{label}</span></button>)}</div>
    <Frame label="Astra Voice · workspace (sample data)" allowOverflow={step1Tour.active}><div
      className={cn("relative grid min-h-[520px] md:grid-cols-[84px_1fr]", step1Tour.active && "pb-8")}
      data-spotlight-root="voice-step-1"
      data-spotlight-on={step1Tour.active ? "true" : undefined}
      onClickCapture={(e) => {
        if (!step1Tour.active) return;
        e.preventDefault();
        e.stopPropagation();
        step1Tour.skip();
      }}
      onKeyDown={(e) => {
        if (!step1Tour.active) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          step1Tour.skip();
        }
      }}
      role={step1Tour.active ? "group" : undefined}
      aria-label={step1Tour.active ? "Step 1 highlight tips. Activate to show the next tip." : undefined}
    >
      <aside className={cn("relative z-[1] hidden border-r border-border bg-surface p-2 md:block", step1Tour.active && "pointer-events-none opacity-50")} aria-hidden={step1Tour.active || undefined}><div className="grid gap-2 text-center text-[10px]">{side.map(({ Icon, label, idx }) => <button key={label} type="button" onClick={() => setStep(idx)} className={cn("grid gap-1 rounded-md py-2", step === idx ? "bg-voice-soft text-voice" : "text-muted-foreground")}><Icon className="mx-auto size-5"/>{label}</button>)}</div></aside>
      <div className="relative z-[1] p-5 sm:p-7"><div className={cn("flex items-center justify-between gap-3", step1Tour.active && "opacity-55")}><h3 className="text-2xl font-bold">{titles[step]}</h3><span className="shrink-0 text-xs tabular-nums text-muted-foreground">Step {step + 1} of {stepCount}</span></div>
        <AnimatePresence mode="wait"><motion.div key={step} initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }} transition={{ duration: .2 }} className="mt-6">{screens[step]}</motion.div></AnimatePresence>
        <div className="mt-6 flex gap-2">
          {step > 0 && <Button variant="outline" onClick={() => setStep(step - 1)}>Back</Button>}
          <SpotlightTarget
            id="continue"
            active={!!continueSpotlight}
            tourActive={step === 0 && step1Tour.active}
            tip={continueSpotlight ? step1Tour.current?.tip : undefined}
            tipLabel={tipLabel}
            reducedMotion={step1Tour.reducedMotion}
            tipPlacement="above"
            className="min-w-0 flex-1"
          >
            <Button
              className="w-full bg-voice hover:bg-voice/90"
              onClick={() => {
                if (step1Tour.active) return;
                setStep(step === stepCount - 1 ? 0 : step + 1);
              }}
            >
              {step === stepCount - 1 ? <><Play/> Start over</> : "Continue"}
            </Button>
          </SpotlightTarget>
        </div>
        {step1Tour.active && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Highlight tips · tap anywhere in this panel to advance
            {step1Tour.reducedMotion ? " · reduced motion: tips stay until you tap" : ""}
          </p>
        )}
      </div>
    </div></Frame>
  </div>;
}
