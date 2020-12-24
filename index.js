async function setupPlugin({ config, global }) {
    // Remove trailing slashes
    config.posthogHost = config.posthogHost.replace(/\/$/, '')
    config.gitlabHost = config.gitlabHost.replace(/\/$/, '')

    global.posthogHost = config.posthogHost.includes('http') ? config.posthogHost : 'https://' + config.posthogHost

    global.gitlabApiBaseUrl =
        (config.gitlabHost.includes('http') ? config.gitlabHost : 'https://' + config.gitlabHost) +
        `/api/v4/projects/${config.gitlabProjectId}`

    global.posthogOptions = {
        headers: {
            Authorization: `Bearer ${config.posthogApiKey}`,
        },
    }

    global.gitlabOptions = config.gitlabToken
        ? {
              headers: {
                  Authorization: `Bearer ${config.gitlabToken}`,
              },
          }
        : {}

    try {
        const posthogRes = await fetchWithRetry(`${global.posthogHost}/api/user`, global.posthogOptions)

        const gitlabRes = await fetchWithRetry(global.gitlabApiBaseUrl, global.gitlabOptions)

        if (posthogRes.status !== 200) {
            throw new Error('Invalid PostHog Personal API key')
        }
        if (gitlabRes.status !== 200) {
            throw new Error('Invalid GitLab project ID, host, or token')
        }
    } catch {
        throw new Error('Invalid PostHog Personal API key')
    }
}

async function runEveryDay({ config, global }) {
    const annotationsResponse = await fetchWithRetry(
        `${global.posthogHost}/api/annotation/?scope=organization&deleted=false`,
        global.posthogOptions
    )

    const annotationsJson = await annotationsResponse.json()
    let annotations = new Set(annotationsJson.results.map((annotation) => annotation.content))

    const gitlabTagsResponse = await fetchWithRetry(`${global.gitlabApiBaseUrl}/repository/tags`, global.gitlabOptions)

    const gitlabTagsJson = await gitlabTagsResponse.json()

    const newTags = gitlabTagsJson
        .filter((tag) => !!tag.commit)
        .map((tag) => ({
            name: tag.name,
            date: tag.commit.authored_date,
        }))
        .filter((tag) => !annotations.has(tag.name))

    for (let tag of newTags) {
        const createAnnotationRes = await fetchWithRetry(
            `${global.posthogHost}/api/annotation/`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.posthogApiKey}`,
                },
                body: JSON.stringify({
                    content: tag.name,
                    scope: 'organization',
                    date_marker: tag.date,
                }),
            },
            'POST'
        )

        if (createAnnotationRes.status === 201) {
            posthog.capture('created_tag_annotation', { tag: tag.name })
        }
    }
}

async function fetchWithRetry(url, options = {}, method = 'GET', isRetry = false) {
    try {
        const res = await fetch(url, { method: method, ...options })
        return res
    } catch {
        if (isRetry) {
            throw new Error(`${method} request to ${url} failed.`)
        }
        const res = await fetchWithRetry(url, options, (method = method), (isRetry = true))
        return res
    }
}