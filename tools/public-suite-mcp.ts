#!/usr/bin/env bun
import {serviceConfig} from "../../shared/agent-config/scripts/ai-native-service-catalog.ts";
import {runServiceMcp} from "../../shared/agent-config/scripts/ai-native-service-surface.ts";

await runServiceMcp(serviceConfig("sigmashake-public-suite"), import.meta.url);
