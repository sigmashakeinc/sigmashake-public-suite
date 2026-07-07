#!/usr/bin/env bun
import {serviceConfig} from "../../shared/agent-config/scripts/ai-native-service-catalog.ts";
import {runServiceCli} from "../../shared/agent-config/scripts/ai-native-service-surface.ts";

await runServiceCli(serviceConfig("sigmashake-public-suite"), import.meta.url);
