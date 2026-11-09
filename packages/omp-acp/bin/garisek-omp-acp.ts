#!/usr/bin/env node
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as AcpAgent from "effect-acp/agent";

import { setup } from "../src/agent.ts";

const binary = process.env.GARISEK_OMP_BINARY ?? "omp";

setup(binary).pipe(
  Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)),
  Effect.scoped,
  NodeRuntime.runMain,
);
