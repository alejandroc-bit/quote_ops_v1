import { z } from "zod";
import { historicalSearchLayerSchema } from "./tms.js";

export const adjustmentDirectionSchema = z.enum(["raise", "lower", "hold"]);

export const recommendationApprovalLevelSchema = z.enum([
  "auto",
  "pricing_manager",
  "commercial_director"
]);

const historicalBoundsSchema = z
  .object({
    selected_layer: historicalSearchLayerSchema,
    min_rate_mxn: z.number().finite().nonnegative(),
    median_rate_mxn: z.number().finite().nonnegative(),
    max_rate_mxn: z.number().finite().nonnegative()
  })
  .strict()
  .superRefine((bounds, ctx) => {
    if (bounds.min_rate_mxn > bounds.median_rate_mxn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "min_rate_mxn must be less than or equal to median_rate_mxn",
        path: ["median_rate_mxn"]
      });
    }

    if (bounds.median_rate_mxn > bounds.max_rate_mxn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "median_rate_mxn must be less than or equal to max_rate_mxn",
        path: ["max_rate_mxn"]
      });
    }
  });

export const recommendationSchema = z
  .object({
    recommendation_id: z.string().regex(/^REC-\d{4}-\d{6}-L\d{2,}$/),
    base_rate_mxn: z.number().finite().nonnegative(),
    recommended_rate_mxn: z.number().finite().nonnegative(),
    adjustment: z
      .object({
        direction: adjustmentDirectionSchema,
        amount_mxn: z.number().finite().nonnegative(),
        percent: z.number().finite(),
        reason: z.string().min(1)
      })
      .strict(),
    historical_bounds: historicalBoundsSchema,
    criteria_used: z.array(z.string().min(1)),
    approval: z
      .object({
        required: z.boolean(),
        level: recommendationApprovalLevelSchema,
        reasons: z.array(z.string().min(1))
      })
      .strict()
  })
  .strict()
  .superRefine((recommendation, ctx) => {
    const delta = recommendation.recommended_rate_mxn - recommendation.base_rate_mxn;
    const direction = recommendation.adjustment.direction;

    if (direction === "raise" && delta <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "raise recommendations must increase recommended_rate_mxn",
        path: ["recommended_rate_mxn"]
      });
    }

    if (direction === "lower" && delta >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lower recommendations must decrease recommended_rate_mxn",
        path: ["recommended_rate_mxn"]
      });
    }

    if (direction === "hold" && delta !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hold recommendations must keep recommended_rate_mxn equal to base_rate_mxn",
        path: ["recommended_rate_mxn"]
      });
    }

    const expectedAmount = Math.abs(delta);
    if (Math.abs(recommendation.adjustment.amount_mxn - expectedAmount) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adjustment.amount_mxn must match the absolute rate delta",
        path: ["adjustment", "amount_mxn"]
      });
    }

    if (direction === "hold" && recommendation.adjustment.percent !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "hold recommendations must have zero adjustment percent",
        path: ["adjustment", "percent"]
      });
    }
  });

export type AdjustmentDirection = z.infer<typeof adjustmentDirectionSchema>;
export type RecommendationApprovalLevel = z.infer<typeof recommendationApprovalLevelSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
