import { Router, type IRouter } from "express";
import {
  AdminLoginBody,
  AdminLoginResponse,
  AdminLogoutResponse,
  GetAdminSessionResponse,
} from "@workspace/api-zod";
import {
  clearAdminCookie,
  createAdminCookie,
  getAdminPassword,
  isAdminAuthenticated,
} from "../lib/adminSession";

const router: IRouter = Router();

router.post("/admin/login", (req, res): void => {
  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A password is required" });
    return;
  }

  if (parsed.data.password !== getAdminPassword()) {
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
  res.json(
    GetAdminSessionResponse.parse({
      authenticated: isAdminAuthenticated(req),
    }),
  );
});

export default router;