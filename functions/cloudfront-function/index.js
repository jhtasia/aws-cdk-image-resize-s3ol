function handler(event) {
  var request = event.request;
  var queryString = request.querystring;
  if (Object.keys(queryString).includes('width')) {
    var width = parseInt(queryString['width'].value);
    if (width) {
      if (width <= 480) width = 480;
      else if (width <= 720) width = 720;
      else if (width <= 1024) width = 1024;
      else if (width <= 1920) width = 1920;
      else width = 3840;
    }
    queryString['width'] = { value: width.toString() };
    return request;
  } else {
    queryString = {};
    return request;
  }
}