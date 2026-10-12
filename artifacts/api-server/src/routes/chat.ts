import OpenAI from "openai";
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { StreamChatReplyBody } from "@workspace/api-zod";

const router: IRouter = Router();

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

router.post("/openai/chat", chatRateLimit, async (req, res): Promise<void> => {
  const parsed = StreamChatReplyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please send a valid chat message." });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "The AI service is not configured." });
    return;
  }

  const client = new OpenAI({ apiKey });
  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const stream = await client.chat.completions.create(
      {
        model: "gpt-5.4-mini",
        max_completion_tokens: 8192,
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant. Keep answers clear, useful, and appropriately concise.",
          },
          ...parsed.data.messages,
        ],
        stream: true,
      },
      { signal: abortController.signal },
    );

    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    if (!res.destroyed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (error) {
    if (abortController.signal.aborted || res.destroyed || res.writableEnded) {
      return;
    }

    const status = error instanceof OpenAI.APIError ? error.status : undefined;
    req.log.error({ status }, "OpenAI chat completion failed");

    if (res.headersSent) {
      res.write(
        `data: ${JSON.stringify({ error: "The AI service could not complete this reply." })}\n\n`,
      );
      res.end();
      return;
    }

    res
      .status(503)
      .json({ error: "The AI service is unavailable. Please try again." });
  }
});

export default router;
