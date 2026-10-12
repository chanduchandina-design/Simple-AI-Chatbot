import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getStreamChatReplyUrl, type ChatMessage } from '@workspace/api-client-react';
import { ArrowUp, Check, Copy, Plus, RotateCcw, Sparkles, Square } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

const prompts = [
  { label: 'Explain something', prompt: 'Why do leaves change color in autumn?' },
  { label: 'Help me think', prompt: 'What makes a good question?' },
  { label: 'Learn a quick fact', prompt: 'How do airplanes stay in the air?' },
];

function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming, error]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function sendMessage(text = draft, history: ChatMessage[] = messages) {
    const content = text.trim();
    if (!content || streaming) return;
    setDraft('');
    setError('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    const nextMessages: ChatMessage[] = [...history, { role: 'user', content }];
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(getStreamChatReplyUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        credentials: 'include',
        body: JSON.stringify({ messages: nextMessages.slice(-40) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `The reply could not be loaded (${response.status}).`;
        try {
          const body = await response.json();
          if (typeof body.error === 'string') detail = body.error;
        } catch { /* Keep the useful status message when the response is not JSON. */ }
        throw new Error(detail);
      }
      if (!response.body) throw new Error('This connection cannot stream a reply. Please try again.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      const handleEvent = (block: string) => {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data) return;
        let event: { content?: string; done?: true; error?: string };
        try { event = JSON.parse(data); } catch { return; }
        if (event.content) {
          setMessages((current) => {
            const updated = [...current];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant') updated[updated.length - 1] = { ...last, content: last.content + event.content };
            return updated;
          });
        }
        if (event.error) throw new Error(event.error);
        if (event.done) finished = true;
      };

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        for (const event of events) handleEvent(event);
      }
      if (buffer.trim()) handleEvent(buffer);
      if (!finished && !controller.signal.aborted) throw new Error('The connection ended before the answer was complete.');
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setMessages((current) => current.at(-1)?.role === 'assistant' && !current.at(-1)?.content
        ? current.slice(0, -1)
        : current);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
    }
  }

  function stopReply() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function copyReply(content: string, index: number) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 1600);
    } catch {
      setError('Could not copy that reply. Try selecting the text instead.');
    }
  }

  function startFresh() {
    if (streaming) stopReply();
    setMessages([]);
    setError('');
    setDraft('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  return (
    <main className="chat-shell paper-grain relative flex min-h-[100dvh] flex-col overflow-hidden text-foreground">
      <header className="relative z-20 flex h-[76px] shrink-0 items-center justify-between border-b border-border/70 px-5 sm:px-9">
        <div className="flex items-center gap-3">
          <div className="brand-mark flex size-9 items-center justify-center rounded-[13px] bg-primary text-primary-foreground shadow-sm">
            <Sparkles size={18} strokeWidth={1.8} />
          </div>
          <div className="leading-none">
            <div className="font-semibold tracking-[-.035em] text-[16px]">goodquestion</div>
            <div className="mt-1.5 font-mono text-[9px] uppercase tracking-[.15em] text-muted-foreground">A little room to wonder</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {messages.length > 0 && (
            <button onClick={startFresh} data-testid="button-new-chat" className="group flex h-9 items-center gap-2 rounded-full border border-border/80 px-3.5 text-[12px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground">
              <Plus size={14} className="transition-transform group-hover:rotate-90" />
              <span className="hidden sm:inline">New chat</span>
            </button>
          )}
          <div className="hidden items-center gap-2 rounded-full bg-primary/5 px-3 py-2 text-[11px] text-primary sm:flex">
            <span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-35" /><span className="relative inline-flex size-1.5 rounded-full bg-primary" /></span>
            Here for the curious
          </div>
        </div>
      </header>

      <section className="relative flex min-h-0 flex-1 flex-col">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-5 pb-12 pt-14 sm:pb-16">
            <div className="message-in mb-7 flex items-center gap-2 rounded-full border border-border/80 bg-card/70 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-accent" />
              Your thoughts, welcome here
            </div>
            <h1 className="message-in max-w-[700px] text-center font-serif text-[clamp(3.25rem,8vw,6.2rem)] leading-[.92] tracking-[-.055em] text-foreground" style={{ animationDelay: '60ms' }}>
              A good place<br className="sm:hidden" /> to <span className="italic text-primary">wonder.</span>
            </h1>
            <p className="message-in mt-6 max-w-[390px] text-center text-[15px] leading-[1.75] text-muted-foreground" style={{ animationDelay: '120ms' }}>
              Ask what you’re curious about. Get a clear answer, a fresh perspective, or a nudge toward something interesting.
            </p>
            <div className="message-in mt-10 grid w-full max-w-[720px] grid-cols-1 gap-2.5 sm:grid-cols-3" style={{ animationDelay: '180ms' }}>
              {prompts.map((item, index) => (
                <button key={item.label} onClick={() => void sendMessage(item.prompt)} data-testid={`button-prompt-${index}`} className="group flex min-h-[82px] flex-col items-start justify-between rounded-2xl border border-border/80 bg-card/55 px-4 py-3.5 text-left transition duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-card hover:shadow-[0_8px_24px_hsl(173_48%_29%/.07)]">
                  <span className="font-mono text-[9px] uppercase tracking-[.12em] text-muted-foreground">{item.label}</span>
                  <span className="flex w-full items-center justify-between gap-2 text-[13px] leading-snug text-foreground/85">
                    {item.prompt}
                    <ArrowUp size={13} className="-rotate-45 shrink-0 text-primary/70 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={scrollRef} className="scrollbar-soft flex-1 overflow-y-auto px-4 sm:px-8">
            <div className="mx-auto w-full max-w-[760px] pb-8 pt-9 sm:pt-12">
              <div className="mb-9 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.13em] text-muted-foreground/80">
                <span className="size-1.5 rounded-full bg-primary/65" />
                This conversation
              </div>
              <div className="space-y-8">
                {messages.map((message, index) => (
                  <article key={`${index}-${message.role}`} className="message-in" data-testid={`message-${message.role}-${index}`}>
                    {message.role === 'user' ? (
                      <div className="ml-auto max-w-[86%] sm:max-w-[76%]">
                        <div className="mb-2 text-right font-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground">You</div>
                        <div className="rounded-[20px] rounded-br-[6px] bg-primary px-5 py-3.5 text-[15px] leading-[1.7] text-primary-foreground shadow-[0_5px_18px_hsl(173_48%_29%/.12)]">
                          {message.content}
                        </div>
                      </div>
                    ) : (
                      <div className="max-w-[94%] sm:max-w-[88%]">
                        <div className="mb-2.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.14em] text-primary">
                          <span className="flex size-[21px] items-center justify-center rounded-[8px] bg-primary/10"><Sparkles size={11} /></span>
                          A thought back
                        </div>
                        {message.content ? (
                          <>
                            <div className="whitespace-pre-wrap text-[15px] leading-[1.85] text-foreground/90">{message.content}</div>
                            {!streaming && (
                              <button onClick={() => void copyReply(message.content, index)} data-testid={`button-copy-${index}`} className="mt-3 inline-flex items-center gap-1.5 rounded-md py-1 text-[11px] text-muted-foreground transition hover:text-primary">
                                {copiedIndex === index ? <Check size={12} /> : <Copy size={12} />}
                                {copiedIndex === index ? 'Copied' : 'Copy answer'}
                              </button>
                            )}
                          </>
                        ) : streaming ? (
                          <div className="flex items-center gap-1.5 py-2" aria-label="Writing a reply" data-testid="status-thinking">
                            <span className="typing-dot size-1.5 rounded-full bg-primary" />
                            <span className="typing-dot size-1.5 rounded-full bg-primary" />
                            <span className="typing-dot size-1.5 rounded-full bg-primary" />
                            <span className="ml-2 font-mono text-[10px] text-muted-foreground">Gathering a thought</span>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {error && (
                <div className="message-in mt-7 flex items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/[.045] px-4 py-3.5" role="alert" data-testid="status-error">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-destructive">That didn’t come through.</div>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{error}</p>
                  </div>
                  <button onClick={() => {
                    const retryHistory = messages.slice();
                    while (retryHistory.at(-1)?.role === 'assistant') retryHistory.pop();
                    const lastUser = retryHistory.pop();
                    if (lastUser?.role === 'user') {
                      setMessages(retryHistory);
                      void sendMessage(lastUser.content, retryHistory);
                    }
                  }} data-testid="button-retry" className="flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/20 bg-card px-3 py-1.5 text-[11px] font-medium text-destructive transition hover:bg-destructive/5">
                    <RotateCcw size={12} /> Try again
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="relative z-20 shrink-0 px-4 pb-4 pt-3 sm:px-8 sm:pb-6">
          <form onSubmit={handleSubmit} className="mx-auto w-full max-w-[760px]">
            <div className="composer-focus rounded-[23px] border border-border bg-card/90 p-2 shadow-[0_12px_38px_hsl(183_31%_16%/.07)] backdrop-blur-md transition-all duration-200">
              <label htmlFor="chat-input" className="sr-only">Ask anything</label>
              <textarea
                id="chat-input"
                ref={textareaRef}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  event.target.style.height = 'auto';
                  event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder="What’s on your mind?"
                rows={1}
                maxLength={8000}
                disabled={streaming}
                data-testid="input-chat"
                className="block max-h-40 min-h-[49px] w-full resize-none bg-transparent px-3.5 pt-[14px] text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/75 disabled:opacity-60 sm:px-4"
              />
              <div className="flex items-center justify-between px-1 pb-0.5 pl-3">
                <span className="text-[10px] text-muted-foreground/75">Clear answers, no account needed</span>
                <div className="flex items-center gap-3">
                  <span className="hidden font-mono text-[9px] text-muted-foreground/60 sm:inline">SHIFT + ENTER for a new line</span>
                  {streaming ? (
                    <button type="button" onClick={stopReply} data-testid="button-stop" aria-label="Stop reply" className="flex size-[35px] items-center justify-center rounded-[13px] bg-accent text-accent-foreground transition hover:scale-[1.04] active:scale-95">
                      <Square size={13} fill="currentColor" />
                    </button>
                  ) : (
                    <button type="submit" disabled={!draft.trim()} data-testid="button-send" aria-label="Send message" className="flex size-[35px] items-center justify-center rounded-[13px] bg-primary text-primary-foreground transition duration-150 hover:scale-[1.04] hover:shadow-[0_4px_12px_hsl(173_48%_29%/.24)] active:scale-95 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/60 disabled:shadow-none">
                      <ArrowUp size={17} strokeWidth={2.2} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-2 flex justify-center">
              <p className="text-center text-[10px] tracking-[.01em] text-muted-foreground/70">A small reminder: the best questions are the ones you actually have.</p>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
