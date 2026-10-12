import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { StreamChatReplyBody } from "@workspace/api-zod";

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
        contents: parsed.data.messages.map((message) => ({
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

    let hasText = false;
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

    if (!res.destroyed && !res.writableEnded) {
      res.write(
        `data: ${JSON.stringify(
          hasText
            ? { done: true }
            : { error: "Google Gemini returned an empty reply. Please try again." },
        )}\n\n`,
      );
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
