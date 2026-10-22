import { useEffect, useMemo, useRef, useState } from 'react';
import { IconSettings, Tooltip } from '../components/ui';
import { useSlate } from '../context/SlateContext';
import { chatAPI } from '../services/api';
import { useAgentStream } from '../hooks/useAgentStream';
import { ChatBlocksProvider } from '../features/chat/blocks/ChatBlocksProvider';
import { ToastProvider } from '../features/chat/blocks/Toasts';
import { blocksFromMessage, normalizeBlocks } from '../features/chat/blocks/blockModel';
import ChatSettingsModal from '../features/chat/ChatSettingsModal';
import ChatShell from '../features/chat/ChatShell';
import Composer from '../features/chat/Composer';
import ContextDrawer from '../features/chat/ContextDrawer';
import ConversationView from '../features/chat/ConversationView';
import SessionRail from '../features/chat/SessionRail';
import SlateContextBar from '../features/chat/SlateContextBar';
import { UNTITLED_SESSION } from '../features/chat/sessionGroups';
import useChatPins from '../features/chat/useChatPins';
import useChatSessions from '../features/chat/useChatSessions';
import useSlateSummary from '../features/chat/useSlateSummary';

export default function ChatPage() {
  const { slate, slateId, site, siteConfig } = useSlate();
  const sessionsState = useChatSessions();
  const { sessions, activeSessionId, setActiveSessionId, refresh, selectSession } = sessionsState;
  const slateSummary = useSlateSummary(slateId);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('gpp');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maxIterations, setMaxIterations] = useState(10);
  const [showReasoning, setShowReasoning] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const inputRef = useRef(null);

  const pins = useChatPins(activeSessionId);
  const { adoptDraft, clearDraft } = pins;

  const stream = useAgentStream();
  const { isStreaming, message: streamedText, error: streamError, metadata, timeline, uiBlocks, startStream, cancelStream, reset: resetStream } = stream;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Live ui_block cards, normalized once for rendering
  const streamBlocks = useMemo(() => normalizeBlocks(uiBlocks), [uiBlocks]);

  // Completed stream -> append the assistant message (prose + ui blocks) and adopt the (possibly new) session
  useEffect(() => {
    if (isStreaming || !metadata || (!streamedText && uiBlocks.length === 0)) return;
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: streamedText,
        metadata: {
          toolsUsed: metadata.toolsUsed,
          agentsUsed: metadata.agentsUsed,
          iterations: metadata.iterations,
          maxIterationsReached: metadata.maxIterationsReached,
        },
        timeline,
        // Same shape session history returns; without blocks the markdown is the answer
        uiBlocks,
        created_at: new Date().toISOString(),
      },
    ]);
    if (metadata.sessionId) {
      adoptDraft(metadata.sessionId);
      setActiveSessionId(metadata.sessionId);
      refresh();
    }
    resetStream();
  }, [isStreaming, streamedText, metadata, timeline, uiBlocks, setActiveSessionId, refresh, resetStream, adoptDraft]);

  useEffect(() => {
    if (!streamError) return;
    if (isStreaming) return; // wait for the stream to close so the timeline is finalized
    setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${streamError}`, timeline, created_at: new Date().toISOString(), isError: true }]);
    resetStream();
  }, [streamError, isStreaming, timeline, resetStream]);

  const newChat = () => {
    setMessages([]);
    clearDraft();
    setActiveSessionId(null);
    resetStream();
    inputRef.current?.focus();
  };

  const openSession = async (id) => {
    setHistoryLoading(true);
    const history = await selectSession(id);
    if (history) setMessages(history);
    setHistoryLoading(false);
  };

  const deleteSession = async (id) => {
    const { wasActive } = await sessionsState.deleteSession(id);
    if (wasActive) newChat();
  };

  const ask = (text) => startStream(text, { sessionId: activeSessionId, slateId, maxIterations, mode });

  const send = async (text) => {
    if (!text.trim() || isStreaming) return;
    setMessages((prev) => [...prev, { role: 'user', content: text, created_at: new Date().toISOString() }]);
    setInput('');
    await ask(text);
  };

  // Drop the last answer and ask the previous prompt again (the server logs the prompt a second time)
  const regenerate = async () => {
    if (isStreaming) return;
    const promptIndex = messages.findLastIndex((m) => m.role === 'user');
    if (promptIndex < 0) return;
    setMessages((prev) => prev.slice(0, promptIndex + 1));
    await ask(messages[promptIndex].content);
  };

  const sendFeedback = async (message, rating) => {
    try {
      const res = await chatAPI.sendFeedback({ rating, sessionId: activeSessionId, messageId: message.id, content: message.content });
      return res.data?.success !== false;
    } catch (err) {
      console.error('Failed to save feedback:', err);
      return false;
    }
  };

  // Latest lineup anywhere in the conversation (streaming blocks win) for the context drawer
  const latestLineup = useMemo(() => {
    const all = [...messages.flatMap(blocksFromMessage), ...streamBlocks];
    return all.findLast((b) => b.type === 'lineup') ?? null;
  }, [messages, streamBlocks]);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const title = activeSessionId ? activeSession?.title || UNTITLED_SESSION : 'New chat';

  return (
    <ToastProvider>
      <ChatBlocksProvider slateId={slateId} site={site} siteConfig={siteConfig} slatePlayers={slateSummary.players} pins={pins}>
        <ChatShell
          title={title}
          drawerCount={pins.pinned.length}
          renderRail={({ collapsed, onToggleCollapse, onClose, dismiss }) => (
            <SessionRail
              sessions={sessions}
              loading={sessionsState.loading}
              error={sessionsState.error}
              activeSessionId={activeSessionId}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
              onClose={onClose}
              onNewChat={() => {
                newChat();
                dismiss();
              }}
              onSelect={(id) => {
                openSession(id);
                dismiss();
              }}
              onRename={sessionsState.renameSession}
              onDelete={deleteSession}
            />
          )}
          actions={
            <Tooltip content="Chat settings" side="bottom">
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                aria-label="Chat settings"
                className="rounded p-1.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <IconSettings size={16} />
              </button>
            </Tooltip>
          }
          contextBar={
            <SlateContextBar
              slate={slate}
              siteName={siteConfig?.name}
              gameCount={slateSummary.gameCount}
              firstLock={slateSummary.firstLock}
              loading={slateSummary.loading}
              mode={mode}
              onModeChange={setMode}
            />
          }
          composer={
            <Composer
              ref={inputRef}
              value={input}
              onChange={setInput}
              onSubmit={send}
              onCancel={cancelStream}
              isStreaming={isStreaming}
              maxIterations={maxIterations}
            />
          }
          renderDrawer={({ onClose }) => <ContextDrawer onClose={onClose} lineup={latestLineup} />}
        >
          <ConversationView
            messages={messages}
            stream={{
              isStreaming,
              content: streamedText,
              timeline,
              blocks: streamBlocks,
            }}
            showReasoning={showReasoning}
            headshots={slateSummary.headshots}
            loading={historyLoading}
            onRegenerate={regenerate}
            onFeedback={sendFeedback}
            onPickPrompt={(text) => {
              setInput(text);
              inputRef.current?.focus();
            }}
          />
        </ChatShell>
      </ChatBlocksProvider>
      <ChatSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        maxIterations={maxIterations}
        setMaxIterations={setMaxIterations}
        showReasoning={showReasoning}
        setShowReasoning={setShowReasoning}
      />
    </ToastProvider>
  );
}
