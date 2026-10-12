import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

const COOKIE_NAME = "goodquestion_browser";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getBrowserId(req: Request, res: Response): string {
  const browserId = req.signedCookies?.[COOKIE_NAME];
  if (typeof browserId === "string" && UUID_PATTERN.test(browserId)) {
    return browserId;
  }

  const newBrowserId = randomUUID();
  res.cookie(COOKIE_NAME, newBrowserId, {
    httpOnly: true,
    maxAge: 365 * 24 * 60 * 60 * 1000,
    path: "/api",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    signed: true,
  });
  return newBrowserId;
}
