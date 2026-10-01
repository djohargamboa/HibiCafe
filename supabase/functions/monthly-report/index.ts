import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const URL = Deno.env.get("SUPABASE_URL") || "";
const CORE = `${URL}/functions/v1/monthly-report-core`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.text();
    const headers: Record<string, string> = {
      "Content-Type": req.headers.get("content-type") || "application/json"
    };

    const auth = req.headers.get("authorization");
    const apikey = req.headers.get("apikey");
    if (auth) headers.Authorization = auth;
    if (apikey) headers.apikey = apikey;

    const upstream = await fetch(CORE, {
      method: "POST",
      headers,
      body
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": upstream.headers.get("content-type") || "application/json"
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" }
      }
    );
  }
});
