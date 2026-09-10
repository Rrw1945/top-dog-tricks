import { Router, type IRouter } from "express";
import healthRouter from "./health";
import storageRouter from "./storage";
import submissionsRouter from "./submissions";
import adminRouter from "./admin";
import engagementRouter from "./engagement";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(adminRouter);
router.use(engagementRouter);
router.use(submissionsRouter);

export default router;
