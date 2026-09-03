import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function getAdminKey() {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const secretMapRaw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (secretMapRaw) {
    try {
      const secretMap = JSON.parse(secretMapRaw)
      return secretMap.default || Object.values(secretMap)[0]
    } catch (_) {}
  }
  return null
}

function getPublicKey() {
  const legacy = Deno.env.get('SUPABASE_ANON_KEY')
  if (legacy) return legacy
  const publishableRaw = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')
  if (publishableRaw) {
    try {
      const keyMap = JSON.parse(publishableRaw)
      return keyMap.default || Object.values(keyMap)[0]
    } catch (_) {}
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const adminKey = getAdminKey()
  const publicKey = getPublicKey()
  if (!supabaseUrl || !adminKey || !publicKey) {
    return json({ error: 'Supabase server configuration is incomplete.' }, 500)
  }

  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Authentication required.' }, 401)
  const accessToken = authHeader.slice(7)

  const callerClient = createClient(supabaseUrl, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(accessToken)
  if (callerError || !callerData.user) return json({ error: 'Invalid or expired session.' }, 401)

  const admin = createClient(supabaseUrl, adminKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: callerProfile, error: profileError } = await admin
    .from('user_profiles')
    .select('auth_user_id,username,display_name,role,active')
    .eq('auth_user_id', callerData.user.id)
    .maybeSingle()

  if (profileError) return json({ error: 'Could not verify your user profile.' }, 500)
  if (!callerProfile || callerProfile.role !== 'superuser' || callerProfile.active === false) {
    return json({ error: 'Superuser access is required.' }, 403)
  }

  let body: any
  try { body = await req.json() } catch (_) { return json({ error: 'Invalid JSON request.' }, 400) }

  const action = body?.action
  if (action === 'create_user') {
    const username = String(body.username || '').trim().toLowerCase()
    const displayName = String(body.display_name || '').trim()
    const password = String(body.password || '')
    const role = body.role === 'superuser' ? 'superuser' : 'user'
    const active = body.active !== false

    if (!username) return json({ error: 'Username is required.' }, 400)
    if (!/^[a-z0-9._-]{2,50}$/.test(username)) return json({ error: 'Username may contain only letters, numbers, dot, underscore and hyphen.' }, 400)
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400)

    const email = `${username}@hibi.local`
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createError || !created.user) {
      return json({ error: createError?.message || 'Could not create Auth user.' }, 400)
    }

    const authUserId = created.user.id
    const permissions = body.permissions || {
      pos: true, grab: true, orders: true, expenses: true,
      dashboard: true, reports: true, menu: true, audit: false, settings: true,
    }

    const { error: insertError } = await admin.from('user_profiles').insert({
      auth_user_id: authUserId,
      username,
      display_name: displayName || username,
      role,
      active,
      permissions,
    })

    if (insertError) {
      await admin.auth.admin.deleteUser(authUserId)
      return json({ error: `Auth user was created but the user profile could not be saved: ${insertError.message}` }, 500)
    }

    return json({ ok: true, auth_user_id: authUserId })
  }

  if (action === 'reset_password') {
    const targetUserId = String(body.target_user_id || '').trim()
    const password = String(body.password || '')
    if (!targetUserId) return json({ error: 'Target user is required.' }, 400)
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400)
    if (targetUserId === callerData.user.id) return json({ error: 'Use My Password to change your own password.' }, 400)

    const { data: targetProfile, error: targetProfileError } = await admin
      .from('user_profiles')
      .select('auth_user_id,username,role,active')
      .eq('auth_user_id', targetUserId)
      .maybeSingle()
    if (targetProfileError) return json({ error: 'Could not find the target user.' }, 404)
    if (!targetProfile) return json({ error: 'Target user does not exist.' }, 404)

    const { error: updateError } = await admin.auth.admin.updateUserById(targetUserId, {
      password,
      email_confirm: true,
    })
    if (updateError) return json({ error: updateError.message }, 400)

    return json({ ok: true })
  }

  return json({ error: 'Unknown action.' }, 400)
})
