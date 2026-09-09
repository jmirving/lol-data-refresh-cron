#!/usr/bin/env node

import { runProcess } from "./process.js";

// Worker registration is deliberately empty until the first integration phase.
const jobs = [];

await runProcess(jobs);
