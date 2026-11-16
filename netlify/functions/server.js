const path = require("path");
const serverless = require("serverless-http");

process.env.PUBLIC_DIR = path.resolve(__dirname, "../../public");

const app = require("../../server");

exports.handler = serverless(app);
