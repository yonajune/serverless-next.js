// @ts-ignore
import PrerenderManifest from "./prerender-manifest.json";
// @ts-ignore
import Manifest from "./manifest.json";
// @ts-ignore
import { basePath } from "./routes-manifest.json";
import lambdaAtEdgeCompat from "thrive-next-aws-cloudfront";
import {
  CloudFrontRequest,
  CloudFrontS3Origin,
  CloudFrontOrigin,
  CloudFrontResultResponse
} from "aws-lambda";
import {
  OriginRequestEvent,
  OriginRequestDefaultHandlerManifest,
  PreRenderedManifest as PrerenderManifestType,
  OriginResponseEvent
} from "../types";
import S3 from "aws-sdk/clients/s3";

const addS3HostHeader = (
  req: CloudFrontRequest,
  s3DomainName: string
): void => {
  req.headers["host"] = [{ key: "host", value: s3DomainName }];
};

const isDataRequest = (uri: string): boolean => uri.startsWith("/_next/data");

const normaliseUri = (uri: string): string => {
  if (basePath) uri = uri.slice(basePath.length);
  return uri === "" ? "/index" : uri;
};

const normaliseS3OriginDomain = (s3Origin: CloudFrontS3Origin): string => {
  if (s3Origin.region === "us-east-1") {
    return s3Origin.domainName;
  }

  if (!s3Origin.domainName.includes(s3Origin.region)) {
    const regionalEndpoint = s3Origin.domainName.replace(
      "s3.amazonaws.com",
      `s3.${s3Origin.region}.amazonaws.com`
    );
    return regionalEndpoint;
  }

  return s3Origin.domainName;
};

const router = (
  manifest: OriginRequestDefaultHandlerManifest
): ((uri: string) => string) => {
  const {
    pages: { ssr, html }
  } = manifest;

  const allDynamicRoutes = { ...ssr.dynamic, ...html.dynamic };

  return (uri: string): string => {
    let normalisedUri = uri;

    if (isDataRequest(uri)) {
      normalisedUri = uri
        .replace(`/_next/data/${manifest.buildId}`, "")
        .replace(".json", "");
    }

    if (ssr.nonDynamic[normalisedUri]) {
      return ssr.nonDynamic[normalisedUri];
    }

    for (const route in allDynamicRoutes) {
      const { file, regex } = allDynamicRoutes[route];

      const re = new RegExp(regex, "i");
      const pathMatchesRoute = re.test(normalisedUri);

      if (pathMatchesRoute) {
        return file;
      }
    }

    // only use the 404 page if the project exports it
    if (html.nonDynamic["/404"] !== undefined) {
      return "pages/404.html";
    }

    return "pages/_error.js";
  };
};

export const handler = async (
  event: OriginRequestEvent | OriginResponseEvent
): Promise<CloudFrontResultResponse | CloudFrontRequest> => {
  const manifest: OriginRequestDefaultHandlerManifest = Manifest;
  const prerenderManifest: PrerenderManifestType = PrerenderManifest;
  if (isOriginResponse(event)) {
    return await handleOriginResponse({ event, manifest, prerenderManifest });
  } else {
    return await handleOriginRequest({ event, manifest, prerenderManifest });
  }
};

const handleOriginRequest = async ({
  event,
  manifest,
  prerenderManifest
}: {
  event: OriginRequestEvent;
  manifest: OriginRequestDefaultHandlerManifest;
  prerenderManifest: PrerenderManifestType;
}) => {
  const request = event.Records[0].cf.request;
  const uri = normaliseUri(request.uri);
  const { pages, publicFiles } = manifest;
  const isStaticPage = pages.html.nonDynamic[uri];
  const isPublicFile = publicFiles[uri];
  const isPrerenderedPage = prerenderManifest.routes[uri]; // prerendered pages are also static pages like "pages.html" above, but are defined in the prerender-manifest
  const origin = request.origin as CloudFrontOrigin;
  const s3Origin = origin.s3 as CloudFrontS3Origin;
  const isHTMLPage = isStaticPage || isPrerenderedPage;
  const normalisedS3DomainName = normaliseS3OriginDomain(s3Origin);
  const hasFallback = hasFallbackForUri(uri, prerenderManifest);

  s3Origin.domainName = normalisedS3DomainName;

  if (isHTMLPage || isPublicFile || hasFallback || isDataRequest(uri)) {
    if (isHTMLPage || hasFallback) {
      s3Origin.path = `${basePath}/static-pages`;
      let pageName = uri === "/" ? "/index" : uri;
      request.uri = `${pageName}.html`;
    }

    if (isPublicFile) {
      s3Origin.path = `${basePath}/public`;
      if (basePath) {
        request.uri = request.uri.replace(basePath, "");
      }
    }

    addS3HostHeader(request, normalisedS3DomainName);
    return request;
  }

  const pagePath = router(manifest)(uri);

  if (pagePath.endsWith(".html")) {
    s3Origin.path = `${basePath}/static-pages`;
    request.uri = pagePath.replace("pages", "");
    addS3HostHeader(request, normalisedS3DomainName);
    return request;
  }

  // eslint-disable-next-line
  const page = require(`./${pagePath}`);
  const { req, res, responsePromise } = lambdaAtEdgeCompat(event.Records[0].cf);
  page.render(req, res);

  return responsePromise;
};

const handleOriginResponse = async ({
  event,
  manifest,
  prerenderManifest
}: {
  event: OriginResponseEvent;
  manifest: OriginRequestDefaultHandlerManifest;
  prerenderManifest: PrerenderManifestType;
}) => {
  const response = event.Records[0].cf.response;
  const request = event.Records[0].cf.request;
  const uri = normaliseUri(request.uri);
  const { status } = response;
  if (status !== "403") return response;
  const { domainName, region } = request.origin!.s3!;
  const bucketName = domainName.replace(`.s3.${region}.amazonaws.com`, "");
  // It's usually better to do this outside the handler, but we need to know the bucket region
  const s3 = new S3({ region: request.origin?.s3?.region });
  if (isDataRequest(uri)) {
    const pagePath = router(manifest)(uri);
    // eslint-disable-next-line
    const page = require(`./${pagePath}`);
    const { req, res, responsePromise } = lambdaAtEdgeCompat(
      event.Records[0].cf
    );
    const isSSG = !!page.getStaticProps;
    const { renderOpts, html } = await page.renderReqToHTML(
      req,
      res,
      "passthrough"
    );
    if (isSSG) {
      const s3JsonParams = {
        Bucket: bucketName,
        Key: uri.replace(/^\//, ""),
        Body: JSON.stringify(renderOpts.pageData),
        ContentType: "application/json"
      };
      const s3HtmlParams = {
        Bucket: bucketName,
        Key: `static-pages/${request.uri
          .replace(`/_next/data/${manifest.buildId}/`, "")
          .replace(".json", ".html")}`,
        Body: html,
        ContentType: "text/html",
        CacheControl: "public, max-age=0, s-maxage=2678400, must-revalidate"
      };
      await Promise.all([
        s3.putObject(s3JsonParams).promise(),
        s3.putObject(s3HtmlParams).promise()
      ]);
    }
    res.writeHead(200, response.headers as any);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(renderOpts.pageData));
    return responsePromise;
  } else {
    const hasFallback = hasFallbackForUri(uri, prerenderManifest);
    if (!hasFallback) return response;
    const s3Params = {
      Bucket: bucketName,
      Key: `static-pages${hasFallback.fallback}`
    };
    const { Body } = await s3.getObject(s3Params).promise();
    return {
      status: "200",
      statusDescription: "OK",
      headers: {
        ...response.headers,
        "content-type": [
          {
            key: "Content-Type",
            value: "text/html"
          }
        ]
      },
      body: Body?.toString("utf-8")
    };
  }
};

const isOriginResponse = (
  event: OriginRequestEvent | OriginResponseEvent
): event is OriginResponseEvent => {
  return event.Records[0].cf.config.eventType === "origin-response";
};

const hasFallbackForUri = (
  uri: string,
  prerenderManifest: PrerenderManifestType
) => {
  return Object.values(prerenderManifest.dynamicRoutes).find((routeConfig) => {
    const re = new RegExp(routeConfig.routeRegex);
    return re.test(uri);
  });
};
