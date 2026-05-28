/**
 * DEV-ONLY email preview routes.
 * Only registered when NODE_ENV !== "production".
 *
 * Usage (server running locally):
 *   http://localhost:4000/dev/email/invite
 *   http://localhost:4000/dev/email/reset
 *   http://localhost:4000/dev/email/lockout
 *   http://localhost:4000/dev/email/lockout-unactivated
 */

import { Router } from "express"
import express from "express"
import type { Request, Response } from "express"
import path from "path"
import { fileURLToPath } from "url"

const router = Router()

// Serve client/public/ at /dev/static so email previews can load assets
// without needing the Vite dev server or a production deploy.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const clientPublic = path.resolve(__dirname, "../../../client/public")
router.use("/static", express.static(clientPublic))

const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5173"

// ── shared shell ────────────────────────────────────────────────────────────
function shell(req: Request, content: string) {
  const logo = `${req.protocol}://${req.get("host")}/dev/static/EWCLOGOEMAIL.png`
  return `
  <div style="background:#0B0B0B;padding:40px;font-family:Arial,sans-serif;color:#F5F1E8;min-height:100vh;">
    <div style="max-width:600px;margin:auto;background:#111111;border:1px solid #242424;border-radius:24px;padding:40px;">
      <div style="text-align:center;margin-bottom:32px;">
        <img src="${logo}" alt="EWC Translation Hub" width="260" style="display:block;margin:0 auto 6px auto;width:400px;height:auto;" />
        <p style="color:#888;margin:0;font-size:14px;">Preview</p>
      </div>
      ${content}
      <div style="margin-top:40px;padding-top:20px;border-top:1px solid #242424;text-align:center;color:#666;font-size:12px;">
        © 2026 EWC Translation Hub
      </div>
    </div>
  </div>`
}

function securityNotice() {
  return `
  <div style="background:#161616;border:1px solid #2A2A2A;border-radius:16px;padding:18px;margin-top:16px;">
    <p style="margin:0 0 10px 0;color:#D6B36A;font-weight:bold;font-size:14px;">Security Notice</p>
    <p style="margin:0;color:#8E8E8E;font-size:13px;line-height:1.6;">
      EWC Translation Hub will never ask for your password by email.
      Only use the official button above and verify that the website domain is:
      <strong style="color:#F5F1E8;">ewctranslations.org</strong>
    </p>
  </div>`
}

function goldButton(href: string, label: string) {
  return `
  <div style="margin:35px 0;text-align:center;">
    <a href="${href}" style="display:inline-block;background:#D6B36A;color:black;text-decoration:none;padding:16px 32px;border-radius:14px;font-weight:bold;font-size:15px;">${label}</a>
  </div>`
}

// ── nav bar ──────────────────────────────────────────────────────────────────
function nav(active: string) {
  const tabs = ["invite", "reset", "lockout", "lockout-unactivated", "source-added"]
  const links = tabs
    .map((t) => {
      const on = t === active
      return `<a href="/dev/email/${t}" style="padding:6px 14px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:${on ? "bold" : "normal"};background:${on ? "#D6B36A" : "#1A1A1A"};color:${on ? "black" : "#A0A0A0"};border:1px solid ${on ? "#D6B36A" : "#2A2A2A"};">${t}</a>`
    })
    .join(" ")
  return `<div style="background:#0B0B0B;padding:14px 40px;border-bottom:1px solid #1E1E1E;display:flex;gap:8px;align-items:center;">${links}</div>`
}

function page(active: string, body: string) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Email preview — ${active}</title></head><body style="margin:0;">${nav(active)}${body}</body></html>`
}

// ── routes ───────────────────────────────────────────────────────────────────

// Invite
router.get("/email/invite", (req: Request, res: Response) => {
  const inviteUrl = `${CLIENT_URL}/setup-password?token=PREVIEW_TOKEN`
  const body = shell(req, `
    <h2 style="margin-top:0;color:white;font-size:24px;">You've been invited</h2>
    <p style="color:#B0B0B0;line-height:1.7;font-size:15px;">
      Your account has been created for the EWC Translation Hub platform.
      Click the button below to securely create your password and access your dashboard.
    </p>
    ${goldButton(inviteUrl, "Set Your Password")}
    ${securityNotice()}
  `)
  res.send(page("invite", body))
})

// Reset password
router.get("/email/reset", (req: Request, res: Response) => {
  const resetUrl = `${CLIENT_URL}/reset-password?token=PREVIEW_TOKEN`
  const body = shell(req, `
    <h2 style="margin-top:0;color:white;font-size:24px;">Reset your password</h2>
    <p style="color:#B0B0B0;line-height:1.7;font-size:15px;">
      We received a request to reset the password for your account.
      Click the button below to set a new password.
      This link expires in <strong style="color:#F5F1E8;">1 hour</strong>.
    </p>
    ${goldButton(resetUrl, "Reset Password")}
    <div style="background:#161616;border:1px solid #2A2A2A;border-radius:16px;padding:18px;margin-top:10px;">
      <p style="margin:0 0 6px 0;color:#f87171;font-weight:bold;font-size:14px;">Didn't request this?</p>
      <p style="margin:0;color:#8E8E8E;font-size:13px;line-height:1.6;">
        Do <strong style="color:#f87171;">not</strong> click the button above.
        Someone may have entered your email address by mistake.
        Your password will <strong style="color:#F5F1E8;">not</strong> change unless you click the button and complete the process.
      </p>
    </div>
    ${securityNotice()}
  `)
  res.send(page("reset", body))
})

// Lockout — activated account
router.get("/email/lockout", (req: Request, res: Response) => {
  const forgotUrl = `${CLIENT_URL}/forgot-password`
  const body = shell(req, `
    <h2 style="margin-top:0;color:white;font-size:24px;">Account Temporarily Locked</h2>
    <p style="color:#B0B0B0;line-height:1.7;font-size:15px;">
      Your account was locked after <strong style="color:#F5F1E8;">5 failed sign-in attempts</strong>.
      It will unlock automatically in <strong style="color:#D6B36A;">5 minutes</strong>.
    </p>
    <div style="background:#0d1a0d;border:1px solid rgba(74,222,128,0.2);border-radius:16px;padding:18px;margin-top:25px;">
      <p style="margin:0 0 8px 0;color:#4ade80;font-weight:bold;font-size:14px;">✓ &nbsp;Was this you?</p>
      <p style="margin:0;color:#8E8E8E;font-size:13px;line-height:1.6;">
        No action needed. Your account will unlock automatically in 5 minutes.
        You can also ask your admin to clear the lockout immediately.
      </p>
    </div>
    <div style="background:#1a0a0a;border:1px solid rgba(248,113,113,0.2);border-radius:16px;padding:18px;margin-top:16px;margin-bottom:25px;">
      <p style="margin:0 0 10px 0;color:#f87171;font-weight:bold;font-size:14px;">✕ &nbsp;Wasn't you?</p>
      <p style="margin:0 0 16px 0;color:#8E8E8E;font-size:13px;line-height:1.6;">Reset your password immediately to secure your account.</p>
      <div style="text-align:center;">
        <a href="${forgotUrl}" style="display:inline-block;background:#D6B36A;color:black;text-decoration:none;padding:16px 32px;border-radius:14px;font-weight:bold;font-size:15px;">Reset My Password</a>
      </div>
    </div>
    ${securityNotice()}
  `)
  res.send(page("lockout", body))
})

// Lockout — unactivated account (never set a password)
router.get("/email/lockout-unactivated", (req: Request, res: Response) => {
  const body = shell(req, `
    <h2 style="margin-top:0;color:white;font-size:24px;">Account Temporarily Locked</h2>
    <p style="color:#B0B0B0;line-height:1.7;font-size:15px;">
      Your account was locked after <strong style="color:#F5F1E8;">5 failed sign-in attempts</strong>.
      It will unlock automatically in <strong style="color:#D6B36A;">5 minutes</strong>.
    </p>
    <div style="background:#0d1a0d;border:1px solid rgba(74,222,128,0.2);border-radius:16px;padding:18px;margin-top:25px;">
      <p style="margin:0 0 8px 0;color:#4ade80;font-weight:bold;font-size:14px;">✓ &nbsp;Was this you?</p>
      <p style="margin:0;color:#8E8E8E;font-size:13px;line-height:1.6;">
        No action needed. Your account will unlock automatically in 5 minutes.
        You can also ask your admin to clear the lockout immediately.
      </p>
    </div>
    <div style="background:#1a0a0a;border:1px solid rgba(248,113,113,0.2);border-radius:16px;padding:18px;margin-top:16px;margin-bottom:25px;">
      <p style="margin:0 0 10px 0;color:#f87171;font-weight:bold;font-size:14px;">✕ &nbsp;Wasn't you?</p>
      <p style="margin:0;color:#8E8E8E;font-size:13px;line-height:1.6;">
        Your account has not been set up yet. Contact your admin to report this and to resend your invitation email.
      </p>
    </div>
    ${securityNotice()}
  `)
  res.send(page("lockout-unactivated", body))
})

// Source file added — translator notification
router.get("/email/source-added", (req: Request, res: Response) => {
  const orderLink = `${CLIENT_URL}?page=Broadcast&orderId=PREVIEW_ID`
  const body = shell(req, `
    <h2 style="margin-top:0;color:white;font-size:24px;">Source File Added</h2>
    <p style="color:#B0B0B0;line-height:1.7;font-size:15px;">
      A new source file has been added for translation. Click the button below to view the order and get started.
    </p>
    <div style="background:#161616;border:1px solid #2A2A2A;border-radius:16px;padding:18px;margin-top:25px;">
      <p style="margin:0 0 10px 0;color:#D6B36A;font-weight:bold;font-size:14px;">Order Details</p>
      <p style="margin:0 0 8px 0;color:#8E8E8E;font-size:13px;line-height:1.6;"><strong style="color:#F5F1E8;">Order:</strong> EWC World Cup Finals Broadcast</p>
      <p style="margin:0 0 8px 0;color:#8E8E8E;font-size:13px;line-height:1.6;"><strong style="color:#F5F1E8;">Department:</strong> Broadcast</p>
      <p style="margin:0 0 8px 0;color:#8E8E8E;font-size:13px;line-height:1.6;"><strong style="color:#F5F1E8;">Game:</strong> League of Legends</p>
      <p style="margin:0 0 8px 0;color:#8E8E8E;font-size:13px;line-height:1.6;"><strong style="color:#F5F1E8;">Delivery Format:</strong> SRT, BURNED_IN</p>
      <p style="margin:0;color:#8E8E8E;font-size:13px;line-height:1.6;">
        <strong style="color:#F5F1E8;">Priority:</strong>
        <strong style="color:#f87171;">HIGH</strong>
      </p>
    </div>
    <div style="margin:35px 0;text-align:center;">
      <a href="${orderLink}" style="display:inline-block;background:#D6B36A;color:black;text-decoration:none;padding:16px 32px;border-radius:14px;font-weight:bold;font-size:15px;">View Order</a>
    </div>
  `)
  res.send(page("source-added", body))
})

export default router
