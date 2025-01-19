import { defineCollection, z } from "astro:content";

const blogCollection = defineCollection({
  schema: z.object({
    title: z.string(),
    date: z.string().date(),
    description: z.string(),
    tag: z.strictObject({
      displayName: z.string(),
      uriName: z.string(),
    }),
  }),
});

export const collections = {
  blog: blogCollection,
};
