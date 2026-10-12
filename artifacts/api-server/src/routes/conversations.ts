import { Router, type IRouter, type Response } from "express";
import {
  GetConversationParams,
  GetConversationResponse,
  ListConversationsResponse,
} from "@workspace/api-zod";
import { getBrowserId } from "../lib/browser-session";
import { supabase } from "../lib/supabase";

const router: IRouter = Router();

function storageUnavailable(res: Response, code?: string): void {
  const missingTable = code === "PGRST205" || code === "42P01";
  res.status(503).json({
    error: missingTable
      ? "Supabase is connected, but its chat table is missing. Run artifacts/ai-chat/supabase/schema.sql in the Supabase SQL Editor."
      : "Saved chat storage is unavailable. Check the Supabase setup and try again.",
  });
}

router.get("/conversations", async (req, res): Promise<void> => {
  const browserId = getBrowserId(req, res);
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("id,title,created_at,updated_at")
    .eq("owner_id", browserId)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    req.log.error({ code: error.code }, "Failed to list saved conversations");
    storageUnavailable(res, error.code);
    return;
  }

  const conversations = (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  const parsed = ListConversationsResponse.safeParse(conversations);
  if (!parsed.success) {
    req.log.error(
      { issueCount: parsed.error.issues.length },
      "Supabase returned invalid saved conversations",
    );
    storageUnavailable(res);
    return;
  }
  res.json(parsed.data);
});

router.get("/conversations/:id", async (req, res): Promise<void> => {
  const params = GetConversationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid conversation ID." });
    return;
  }

  const browserId = getBrowserId(req, res);
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("id,title,messages,created_at,updated_at")
    .eq("id", params.data.id)
    .eq("owner_id", browserId)
    .maybeSingle();

  if (error) {
    req.log.error({ code: error.code }, "Failed to load saved conversation");
    storageUnavailable(res, error.code);
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }

  const parsed = GetConversationResponse.safeParse({
    id: data.id,
    title: data.title,
    messages: data.messages,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  });
  if (!parsed.success) {
    req.log.error(
      { issueCount: parsed.error.issues.length },
      "Supabase returned an invalid saved conversation",
    );
    storageUnavailable(res);
    return;
  }
  res.json(parsed.data);
});

export default router;
