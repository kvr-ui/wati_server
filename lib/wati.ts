export async function sendWatiTemplateMessage(phone: string, name: string) {
  const baseUrl = process.env.WATI_API_URL
  const token = process.env.WATI_TOKEN
  const templateName = process.env.WATI_TEMPLATE_NAME
  const appUrl = process.env.APP_URL || 'http://localhost:3000'

  if (!baseUrl || !token || !templateName) {
    throw new Error('WATI is not configured (WATI_API_URL / WATI_TOKEN / WATI_TEMPLATE_NAME)')
  }

  const vslUrl = `${appUrl}/vsl?phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`
  const url = `${baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      template_name: templateName,
      broadcast_name: `zoho_flow_${Date.now()}`,
      parameters: [
        { name: 'name', value: name },
        { name: 'vsl_url', value: vslUrl },
      ],
    }),
  })

  const data = await res.json().catch(() => null)
  if (!res.ok || data?.result === false) {
    throw new Error(`WATI send failed: ${res.status} ${JSON.stringify(data)}`)
  }
  return data
}
