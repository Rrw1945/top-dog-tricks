import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requestLogSerializers } from "./lib/requestLogSerializers";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: requestLogSerializers,
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const apiErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error({ err: error }, "Unhandled API request error");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
};

app.use(apiErrorHandler);

export default app;
