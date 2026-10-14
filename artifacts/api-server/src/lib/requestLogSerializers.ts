import type { IncomingMessage, ServerResponse } from "node:http";

export const requestLogSerializers = {
  req(req: IncomingMessage) {
    return {
      id: req.id,
      method: req.method,
      url: req.url?.split("?")[0],
    };
  },
  res(res: ServerResponse) {
    return {
      statusCode: res.statusCode,
    };
  },
};
