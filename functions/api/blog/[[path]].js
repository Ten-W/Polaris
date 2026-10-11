import { handleBlogRequest } from "../../../server/blog-api.mjs";
export const onRequest = ({ request, env }) => handleBlogRequest(request, env);
