async function setupPlugin({ config, global }) {
    // Remove trailing slashes

    config.gitlabHost = (config.gitlabHost || 'https://gitlab.com').replace(/\/$/, '')

    global.posthogHost = config.posthogHost.includes('http') ? config.posthogHost : 'https://' + config.posthogHost

    global.gitlabApiBaseUrl =
        (config.gitlabHost.includes('http') ? config.gitlabHost : 'https://' + config.gitlabHost) +
        `/api/v4/projects/${config.gitlabProjectId}`

    global.gitlabOptions = config.gitlabToken
        ? {
              headers: {
                  Authorization: `Bearer ${config.gitlabToken}`,
              },
          }
        : {}

    const gitlabRes = await fetchWithRetry(global.gitlabApiBaseUrl, global.gitlabOptions)

    if (gitlabRes.status !== 200) {
        let resp = null;
        try {
            resp = await gitlabRes.text()
        } catch {}
       
        throw new Error(`Gitlab returned ${gitlabRes.status} - ${resp}`)
    }
}


async function runEveryHour({ config, global, cache }) {
    let allPostHogAnnotations = []
    
    let next = true

    while (next) {
        const annotationsResponse = await posthog.api.get(next === true ? '/api/projects/@current/annotations/?scope=project&deleted=false' : next, {
            host: global.posthogHost
        })
        const annotationsJson = await annotationsResponse.json()
        const annotationNames = annotationsJson.results.map((annotation) => annotation.content)
        next = annotationsJson.next?.replace(global.posthogHost, '')
        allPostHogAnnotations = [...allPostHogAnnotations, ...annotationNames]
    }

    let annotations = new Set(allPostHogAnnotations)

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
        const tagData = {
            content: tag.name,
            scope: 'project',
            date_marker: tag.date,
        }
        
        const createAnnotationRes = await posthog.api.post('/api/projects/@current/annotations/', { host: global.posthogHost, data: tagData })
        if (createAnnotationRes.status === 201) {
            console.log(`added annotation: ${tag.name}`)
        }
    }
}

async function fetchWithRetry(url, options = {}, method = 'GET', isRetry = false) {
    try {
        const res = await fetch(url, { method: method, ...options })
        return res
    } catch (err) {
        if (isRetry) {
            throw new Error(`${method} request to ${url} failed with error: ${err.message || String(err)}`)
        }
        const res = await fetchWithRetry(url, options, (method = method), (isRetry = true))
        return res
    }
}
