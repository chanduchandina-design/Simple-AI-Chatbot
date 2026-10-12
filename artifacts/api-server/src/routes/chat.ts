import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { StreamChatReplyBody } from "@workspace/api-zod";
import { getBrowserId } from "../lib/browser-session";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();
const geminiUrl =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse";

type GeminiStreamChunk = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
};

type StoredMessage = { role: "user" | "assistant"; content: string };

const chatRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res): void => {
    res.status(429).json({
      error: "Too many messages. Please wait a few minutes before trying again.",
    });
  },
});

router.post("/gemini/chat", chatRateLimit, async (req, res): Promise<void> => {
  const parsed = StreamChatReplyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please send a valid chat message." });
    return;
  }

  const apiKey = process.env.NIAT?.trim();
  if (!apiKey) {
    res.status(503).json({ error: "The Google AI service is not configured." });
    return;
  }

  const browserId = getBrowserId(req, res);
  const conversationId = parsed.data.conversationId;
  const { data: existingConversation, error: loadError } = await supabase
    .from("chat_conversations")
    .select("id,owner_id,title,messages,created_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (loadError) {
    req.log.error({ code: loadError.code }, "Failed to load conversation before reply");
    res.status(503).json({
      error:
        loadError.code === "PGRST205" || loadError.code === "42P01"
          ? "Supabase is connected, but its chat table is missing. Run artifacts/ai-chat/supabase/schema.sql in the Supabase SQL Editor."
          : "Supabase chat storage is unavailable. Check the Supabase setup and try again.",
    });
    return;
  }
  if (existingConversation && existingConversation.owner_id !== browserId) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }

  const storedMessages = (existingConversation?.messages ?? []) as StoredMessage[];
  const lastStoredMessage = storedMessages.at(-1);
  const userMessage: StoredMessage = {
    role: "user",
    content: parsed.data.message,
  };
  const conversationMessages =
    lastStoredMessage?.role === "user" &&
    lastStoredMessage.content === userMessage.content
      ? storedMessages
      : [...storedMessages, userMessage];

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "You are a helpful assistant. Keep answers clear, useful, and appropriately concise.",
            },
          ],
        },
        contents: conversationMessages.slice(-40).map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
        generationConfig: { maxOutputTokens: 8192 },
      }),
      signal: abortController.signal,
    });

    if (!geminiResponse.ok) {
      const status = geminiResponse.status;
      req.log.warn({ status }, "Gemini rejected a chat request");
      const error =
        status === 400
          ? "Google Gemini rejected the request. Check that the key is valid and Gemini API access is enabled."
          : status === 401 || status === 403
            ? "Google rejected the API key. Check that NIAT contains a valid key with Gemini API access."
            : status === 404
              ? "Google Gemini could not find the requested model for this key."
              : status === 429
                ? "Google Gemini is rate-limited or its quota is exhausted. Please try again later."
                : "Google Gemini is temporarily unavailable. Please try again.";
      res.status(503).json({ error });
      return;
    }

    if (!geminiResponse.body) {
      res.status(503).json({ error: "Google Gemini did not return a response stream." });
      return;
    }

    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ conversationId })}\n\n`);

    let hasText = false;
    let fullReply = "";
    let buffer = "";
    const decoder = new TextDecoder();
    const processLine = (line: string): void => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;

      const chunk = JSON.parse(data) as GeminiStreamChunk;
      for (const candidate of chunk.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (typeof part.text !== "string" || !part.text || part.thought) continue;
          hasText = true;
          fullReply += part.text;
          res.write(`data: ${JSON.stringify({ content: part.text })}\n\n`);
        }
      }
    };

    const reader = geminiResponse.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);

    if (!hasText) {
      res.write(
        `data: ${JSON.stringify({ error: "Google Gemini returned an empty reply. Please try again." })}\n\n`,
      );
      res.end();
      return;
    }

    const now = new Date().toISOString();
    const updatedMessages: StoredMessage[] = [
      ...conversationMessages,
      { role: "assistant", content: fullReply },
    ];
    const title =
      existingConversation?.title ??
      parsed.data.message.trim().split(/\r?\n/, 1)[0].slice(0, 80);
    const saveResult = existingConversation
      ? await supabase
          .from("chat_conversations")
          .update({
            title,
            messages: updatedMessages,
            updated_at: now,
          })
          .eq("id", conversationId)
          .eq("owner_id", browserId)
      : await supabase.from("chat_conversations").insert({
          id: conversationId,
          owner_id: browserId,
          title,
          messages: updatedMessages,
          created_at: now,
          updated_at: now,
        });

    if (saveResult.error) {
      req.log.error(
        { code: saveResult.error.code },
        "Failed to save completed conversation",
      );
      res.write(
        `data: ${JSON.stringify({
          error:
            "Your reply was generated, but it could not be saved. Check the Supabase setup and try again.",
        })}\n\n`,
      );
      res.end();
      return;
    }

    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true, conversationId })}\n\n`);
      res.end();
    }
  } catch (error) {
    if (abortController.signal.aborted || res.destroyed || res.writableEnded) {
      return;
    }

    req.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Gemini chat completion failed",
    );

    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: "Google Gemini could not complete this reply." })}\n\n`,
      );
      res.end();
      return;
    }

    res
      .status(503)
      .json({ error: "Google Gemini is unavailable. Please try again." });
  }
});

export default router;
