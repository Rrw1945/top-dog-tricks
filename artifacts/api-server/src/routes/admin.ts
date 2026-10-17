import { Router, type IRouter } from "express";
import {
  AdminLoginBody,
  AdminLoginResponse,
  AdminLogoutResponse,
  GetAdminSessionResponse,
  GetWelcomeEmailAdminRecordsQueryParams,
  GetWelcomeEmailAdminRecordsResponse,
  GetNewsletterFunnelReportResponse,
  GetDeferredConfirmationAdminStatusResponse,
} from "@workspace/api-zod";
import {
  getNewsletterFunnelReport,
  getDeferredConfirmationAdminStatus,
  listWelcomeEmailAdminRecords,
} from "./engagement";
import {
  clearAdminCookie,
  createAdminCookie,
  getAdminPassword,
  isAdminAuthenticated,
} from "../lib/adminSession";
import { notifyNewsletterCoverageRegressions } from "../lib/newsletterFunnelNotifications";

const router: IRouter = Router();

router.post("/admin/login", (req, res): void => {
  const adminPassword = getAdminPassword();
  if (!adminPassword || !process.env.SESSION_SECRET?.trim()) {
    res.status(503).json({ error: "Admin login is unavailable until credentials are configured" });
    return;
  }

  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A password is required" });
    return;
  }

  if (parsed.data.password !== adminPassword) {
    req.log.warn("Failed admin login attempt");
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  res.setHeader("Set-Cookie", createAdminCookie());
  res.json(AdminLoginResponse.parse({ authenticated: true }));
});

router.post("/admin/logout", (_req, res): void => {
  res.setHeader("Set-Cookie", clearAdminCookie());
  res.json(AdminLogoutResponse.parse({ authenticated: false }));
});

router.get("/admin/session", (req, res): void => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(
    GetAdminSessionResponse.parse({
      authenticated: isAdminAuthenticated(req),
    }),
  );
});

router.get("/admin/welcome-emails", async (req, res): Promise<void> => {
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: "Admin authentication required" });
    return;
  }

  const query = GetWelcomeEmailAdminRecordsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Invalid welcome email pagination" });
    return;
  }

  try {
    const page = await listWelcomeEmailAdminRecords(query.data);
    res.json(GetWelcomeEmailAdminRecordsResponse.parse(page));
  } catch (error) {
    req.log?.warn({ err: error }, "Invalid welcome email pagination cursor");
    res.status(400).json({ error: "Invalid welcome email pagination" });
  }
});

router.get("/admin/deferred-confirmations", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "private, no-store");
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: "Admin authentication required" });
    return;
  }

  try {
    const status = await getDeferredConfirmationAdminStatus();
    res.json(GetDeferredConfirmationAdminStatusResponse.parse(status));
  } catch (error) {
    req.log.error(
      { err: error },
      "Deferred confirmation status query failed",
    );
    res.status(503).json({ error: "Deferred confirmation status unavailable" });
  }
});

router.get("/admin/newsletter-funnel", async (req, res): Promise<void> => {
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: "Admin authentication required" });
    return;
  }

  try {
    const report = await getNewsletterFunnelReport();
    void notifyNewsletterCoverageRegressions(report, {
      onProviderFailure: (channel, error) => {
        req.log.warn(
          { err: error, channel },
          "Newsletter funnel coverage notification provider failed",
        );
      },
    }).catch((error) => {
      req.log.error(
        { err: error },
        "Newsletter funnel coverage notification failed",
      );
    });
    res.json(GetNewsletterFunnelReportResponse.parse(report));
  } catch (error) {
    req.log.error({ err: error }, "Newsletter funnel analytics query failed");
    res.status(503).json({ error: "Newsletter funnel analytics unavailable" });
  }
});

export default router;
