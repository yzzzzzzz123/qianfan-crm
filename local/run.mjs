import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareProduction } from './production-config.mjs';
import { prepareAI } from './ai-config.mjs';
import { prepareCompanyProfile } from './company-profile-config.mjs';
import { prepareLocalCompanyProfileAutomation } from './company-profile-automation.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
prepareProduction(projectRoot);
prepareAI(projectRoot);
prepareCompanyProfile(projectRoot);

const { start } = await import("../app/server/index.mjs");
// A local preview can explicitly disable background collection without changing
// the owner's persisted configuration or weakening the normal authorization.
const previewOnly=process.env.QFCRM_PREVIEW_MANUAL_ONLY==='1';
start({companyProfileLocalAutomation:previewOnly?null:prepareLocalCompanyProfileAutomation(projectRoot)});
