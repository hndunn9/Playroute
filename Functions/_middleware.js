const EU_EEA_UK = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT',
  'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
  'IS','LI','NO',
  'GB'
]);

const CONSENT_SNIPPET = `
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" id="silktide-consent-manager-css" href="https://cdn.jsdelivr.net/gh/silktide/consent-manager@v2.0.1/silktide-consent-manager.css" integrity="sha384-EdMq+R+YOnsbelo08wPenoTlnxbAyxI11NMIxzugx/qAsbh64KcOkqxYqq6pfvO/" crossorigin="anonymous">
<style id="silktide-consent-manager-overrides">#stcm-wrapper{--boxShadow:-5px 5px 10px 0px #00000012,0px 0px 50px 0px #0000001a;--fontFamily:Helvetica Neue,Segoe UI,Arial,sans-serif;--primaryColor:#533be2;--backgroundColor:#f9f5ea;--textColor:#1E3731;--backdropBackgroundColor:#00000033;--backdropBackgroundBlur:0px;--iconColor:#F9F5EA;--iconBackgroundColor:#1E3731}</style>
<script src="https://cdn.jsdelivr.net/gh/silktide/consent-manager@v2.0.1/silktide-consent-manager.js" integrity="sha384-5Pt34uiIbCsvfiiZXoLi4HRf/YBXjr9c8e+gYeVo9smUaInNHYVtc8NZ8wUnXJIq" crossorigin="anonymous"><\/script>
<script>window.silktideConsentManager.init({backdrop:{show:false},icon:{position:"bottomLeft"},prompt:{position:"bottomRight"},consentTypes:[{id:"essential",label:"Essential",description:"<p>These cookies are necessary for the website to function properly and cannot be switched off. They help with things like logging in and setting your privacy preferences.</p>",required:true,onAccept:function(){console.log('Add logic for the required Essential consent type here')}},{id:"marketing",label:"Marketing",description:"<p>These cookies help us improve the site by tracking which pages are most popular and how visitors move around the site.</p>",required:false,gtag:["ad_storage","ad_user_data","ad_personalization"]}],text:{prompt:{description:"<p>We use cookies on our site to enhance your user experience, provide personalized content, and analyze our traffic.</p>",acceptAllButtonText:"Accept",acceptAllButtonAccessibleLabel:"Accept all cookies",rejectNonEssentialButtonText:"Reject non-essential",rejectNonEssentialButtonAccessibleLabel:"Reject all non-essential cookies",preferencesButtonText:"Settings",preferencesButtonAccessibleLabel:"Toggle preferences"},preferences:{title:"Customize your cookie preferences",description:"<p>We respect your right to privacy. You can choose not to allow some types of cookies. Your cookie preferences will apply across our website.</p>",saveButtonText:"Save and close",saveButtonAccessibleLabel:"Save your cookie preferences",creditLinkText:"Get this banner for free",creditLinkAccessibleLabel:"Get this banner for free"}}});<\/script>`;

class HeadInjector {
  element(element) {
    element.append(CONSENT_SNIPPET, { html: true });
  }
}

export async function onRequest(context) {
  const response = await context.next();
  const contentType = response.headers.get('content-type') || '';
  
  if (!contentType.includes('text/html')) {
    return response;
  }

  const country = context.request.headers.get('cf-ipcountry');
  
  if (country && EU_EEA_UK.has(country)) {
    return new HTMLRewriter()
      .on('head', new HeadInjector())
      .transform(response);
  }

  return response;
}
