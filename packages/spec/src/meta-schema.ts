/**
 * WorkflowSpec 0.1 meta-schema.
 *
 * Enforced by Ajv 2020-12 with strict mode, allErrors, no coercion, no default
 * injection and no additional-property removal: a typo in a field name must be a
 * rejection, never a silently rewritten spec.
 */
import type { JsonSchema } from "./types.js";

const valueExpr: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["ref"],
      properties: { ref: { $ref: "#/$defs/ref" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["literal"],
      properties: { literal: true },
    },
  ],
};

const ref: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "path"],
  properties: {
    scope: { type: "string", enum: ["input", "node", "item"] },
    node: { type: "string" },
    path: {
      type: "array",
      items: { oneOf: [{ type: "string" }, { type: "integer", minimum: 0 }] },
    },
  },
};

const bindings: JsonSchema = {
  type: "object",
  additionalProperties: { $ref: "#/$defs/valueExpr" },
};

const condition: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["op", "left", "right"],
      properties: {
        op: { type: "string", enum: ["eq", "lt"] },
        left: { $ref: "#/$defs/valueExpr" },
        right: { $ref: "#/$defs/valueExpr" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["op", "value"],
      properties: {
        op: { const: "is_empty" },
        value: { $ref: "#/$defs/valueExpr" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["op", "conditions"],
      properties: {
        op: { type: "string", enum: ["any", "all"] },
        conditions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { $ref: "#/$defs/condition" },
        },
      },
    },
  ],
};

const agentTask: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "outputSchema"],
  properties: {
    prompt: { type: "string", minLength: 1 },
    outputSchema: { type: "string", minLength: 1 },
    bindings: { $ref: "#/$defs/bindings" },
    label: { $ref: "#/$defs/valueExpr" },
  },
};

const stepBase = {
  type: "object" as const,
  additionalProperties: false,
};

const stepsArray: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: 32,
  items: { $ref: "#/$defs/step" },
};

export const workflowSpecSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://workflow-forge.dev/schemas/workflow-spec-0.1.json",
  type: "object",
  additionalProperties: false,
  required: [
    "specVersion",
    "workflowId",
    "version",
    "inputContract",
    "normalizedInputContract",
    "outputContract",
    "limits",
    "assets",
    "steps",
  ],
  properties: {
    specVersion: { const: "0.1" },
    workflowId: { type: "string", pattern: "^[a-z][a-z0-9-]{1,62}$" },
    version: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$" },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    inputContract: { type: "string", minLength: 1 },
    normalizedInputContract: { type: "string", minLength: 1 },
    outputContract: { type: "string", minLength: 1 },
    limits: {
      type: "object",
      additionalProperties: false,
      required: ["maxMaterials", "mapConcurrency", "maxDirectAgents"],
      properties: {
        maxMaterials: { type: "integer", minimum: 1, maximum: 4 },
        mapConcurrency: { type: "integer", minimum: 1, maximum: 2 },
        maxDirectAgents: { type: "integer", minimum: 1, maximum: 5 },
      },
    },
    assets: {
      type: "object",
      additionalProperties: false,
      required: ["prompts", "schemas"],
      properties: {
        prompts: {
          type: "object",
          minProperties: 1,
          additionalProperties: { type: "string", minLength: 1 },
        },
        schemas: {
          type: "object",
          minProperties: 1,
          additionalProperties: {
            type: "object",
            minProperties: 1,
            properties: {},
          },
        },
      },
    },
    steps: stepsArray,
  },
  $defs: {
    valueExpr,
    ref,
    bindings,
    condition,
    agentTask,
    steps: stepsArray,
    step: {
      oneOf: [
        {
          ...stepBase,
          required: ["id", "kind", "prompt", "outputSchema"],
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { const: "agent" },
            prompt: { type: "string", minLength: 1 },
            outputSchema: { type: "string", minLength: 1 },
            bindings: { $ref: "#/$defs/bindings" },
            label: { $ref: "#/$defs/valueExpr" },
          },
        },
        {
          ...stepBase,
          required: ["id", "kind", "items", "task"],
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { const: "agent_map" },
            items: { $ref: "#/$defs/valueExpr" },
            task: { $ref: "#/$defs/agentTask" },
            failurePolicy: { type: "string", enum: ["fail", "collect"] },
          },
        },
        {
          ...stepBase,
          required: ["id", "kind", "op", "bindings"],
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { const: "transform" },
            op: {
              type: "string",
              enum: ["collect_evidence", "select_fields", "stable_sort"],
            },
            bindings: { $ref: "#/$defs/bindings" },
            fields: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: { type: "string", minLength: 1 },
            },
          },
        },
        {
          ...stepBase,
          required: ["id", "kind", "rules"],
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { const: "assert" },
            rules: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                type: "string",
                enum: [
                  "input_limits",
                  "evidence_ids_exist",
                  "required_dimensions",
                  "non_empty_brief",
                  "result_size",
                ],
              },
            },
            bindings: { $ref: "#/$defs/bindings" },
          },
        },
        {
          ...stepBase,
          required: ["id", "kind", "condition", "then", "else"],
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { const: "branch" },
            condition: { $ref: "#/$defs/condition" },
            then: { $ref: "#/$defs/steps" },
            else: { $ref: "#/$defs/steps" },
          },
        },
        {
          ...stepBase,
          required: ["id", "kind", "status"],
          properties: {
            id: { type: "string", minLength: 1 },
            kind: { const: "result" },
            status: { type: "string", enum: ["completed", "insufficient_input"] },
            value: {
              type: "object",
              additionalProperties: { $ref: "#/$defs/valueExpr" },
            },
          },
        },
      ],
    },
  },
};
