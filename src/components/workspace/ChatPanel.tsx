"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Sparkles, Loader2, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { TimelineDefinition } from "@/lib/types/timeline";
import type { ChatMessage, EditCommand } from "@/lib/types/editCommand";

interface ChatPanelProps {
  timeline: TimelineDefinition | null;
  onTimelineUpdate: (timeline: TimelineDefinition, commands: EditCommand[]) => void;
}

export function ChatPanel({ timeline, onTimelineUpdate }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    if (!timeline) {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}_resp`,
          role: "assistant",
          content: "Generate an edit first, then I can help you modify it.",
          timestamp: new Date(),
        },
      ]);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input, timeline }),
      });

      const data = await res.json();

      const assistantMessage: ChatMessage = {
        id: `${Date.now()}_resp`,
        role: "assistant",
        content: data.reply ?? data.error ?? "Something went wrong.",
        timestamp: new Date(),
        commands: data.commands ?? [],
        applied: !!data.timeline,
      };

      setMessages((prev) => [...prev, assistantMessage]);

      // Apply timeline changes
      if (data.timeline && data.commands?.length > 0) {
        onTimelineUpdate(data.timeline, data.commands);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}_err`,
          role: "assistant",
          content: "Failed to process your request. Please try again.",
          timestamp: new Date(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full border-t">
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-xs font-medium">Edit Assistant</span>
        {timeline && (
          <Badge variant="outline" className="text-[9px] ml-auto">
            {timeline.segments.length} segments · {timeline.duration.toFixed(1)}s
          </Badge>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
        {messages.length === 0 && (
          <div className="text-center py-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Describe changes to your edit in natural language
            </p>
            <div className="flex flex-wrap gap-1 justify-center">
              {[
                "Make captions bigger",
                "Change to warm color grade",
                "Add PIP overlay layout",
                "Use fade transitions",
                "Make the hook more dramatic",
              ].map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px]"
                  onClick={() => {
                    setInput(suggestion);
                  }}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className="space-y-1">
            <div
              className={`text-sm px-3 py-1.5 rounded-lg max-w-[85%] ${
                msg.role === "user"
                  ? "ml-auto bg-primary text-primary-foreground"
                  : "bg-muted"
              }`}
            >
              {msg.content}
            </div>
            {/* Show applied commands */}
            {msg.commands && msg.commands.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-1">
                {msg.commands.map((cmd, i) => (
                  <Badge
                    key={i}
                    variant="secondary"
                    className="text-[8px] gap-0.5"
                  >
                    {msg.applied ? (
                      <Check className="h-2 w-2 text-green-600" />
                    ) : (
                      <AlertCircle className="h-2 w-2 text-amber-500" />
                    )}
                    {cmd.description}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Thinking...
          </div>
        )}
      </div>
      <div className="flex gap-2 p-3 border-t">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={timeline ? "Describe an edit change..." : "Generate an edit first..."}
          disabled={!timeline || loading}
          className="flex-1 rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <Button
          size="sm"
          onClick={handleSend}
          disabled={!input.trim() || loading || !timeline}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
