class Vector { 

	constructor(a, b, c) {
		this.o = a;
		this.s = b;
		this.n = c
	}
}
class TNT { 

	constructor(params) {

		this.x = 0;
		this.y = 0;
		this.w = 0;
		this.h = 0;
	//	this.value = undefined;
		var w = document.getElementsByTagName("body")[0].offsetWidth;
		var h = document.getElementsByTagName("body")[0].offsetHeight;
		if ( h > w )
		{
			var r = w / 6 ;
			this.w = r;
			this.h = r
		}
		else
		{
			var r = h / 6 ;
			this.w = r;
			this.h = r;				
		}
			

		if ( params == undefined )
		{
			this.type = "stick";
			this.x = w - 1.1*this.w;
			this.y = h  -	1.1*this.h;
		}
		else
		{
			this.x = params.x*w;
			this.y = params.y*h;
			this.type = params.type;
		}
		

		var px = this.x;
		var py = this.y;
		var pw = this.w;
		var ph = this.h;

		this.stickground = document.createElement('div');
		this.stickground.id= "stick-ground-"+getRandomId();
		this.stickground.style.borderRadius = this.w/2+4+"px";
		this.stickground.style.border = "solid 4px #999";
		this.stickground.style.background= "rgba(0,0,0,0.0)";
		this.stickground.style.position = "fixed";
		this.stickground.style.top = (this.y-(this.h/2+4))+"px";
		this.stickground.style.left = (this.x-(this.w/2+4))+"px";
		this.stickground.style.width = this.w+"px";
		this.stickground.style.height = this.h+"px";
		document.getElementsByTagName('body')[0].appendChild(this.stickground);

		this.stick = document.createElement('div');
		this.stick.id= "stick"+getRandomId();
		this.stick.style.borderRadius = this.w/2+4+"px";
		this.stick.style.border = "solid 4px #ddd";
		this.stick.style.background= "rgba(0,0,0,0.0)";
		this.stick.style.position = "fixed";
		this.stick.style.top = (this.y-(this.h/2+4))+"px";
		this.stick.style.left = (this.x-(this.w/2+4))+"px";
		this.stick.style.width = this.w+"px";
		this.stick.style.height = this.h+"px";
		document.getElementsByTagName('body')[0].appendChild(this.stick);


		var s = this.stick;
		var nt = 0;
		var target = "";

		this.stick.addEventListener("touchmove",  function (evt) {
		
			var v = vectfromvertices([px, py, 0], [evt.touches[nt].clientX, evt.touches[nt].clientY, 0]);
			var intensity = v.n/50*15;
			if ( intensity > 15 ) intensity = 15;

			s.style.border = "solid 4px #ddd";
			s.style.background = "#eee";

			s.style.position = "fixed";
			s.style.top = (py-ph/2-5)+v.s[1]*intensity+"px";
			s.style.left = (px-pw/2-4)+v.s[0]*intensity+"px";
		
		}, false);;
		this.stick.addEventListener("touchstart",  function (evt) {
			
			for ( var i = 0 ; i < evt.touches.length ; i++)
				if ( evt.touches[i].target.id  == s.id ) nt = i;
		
		
			evt.preventDefault();
			var v = vectfromvertices([px, py, 0], [evt.touches[nt].clientX, evt.touches[nt].clientY, 0]);
			var intensity = v.n/50*15;
			if ( intensity > 15 ) intensity = 15;

			s.style.border = "solid 4px #ddd";
			s.style.background = "#eee";

			s.style.position = "fixed";
			s.style.top = (py-ph/2-5)+v.s[1]*intensity+"px";
			s.style.left = (px-pw/2-4)+v.s[0]*intensity+"px";
		
		}, false);;
		this.stick.addEventListener("touchend",  function (evt) {
		
			s.style.border = "solid 4px #ddd";
			s.style.background = "rgba(255,255,255,0.01)";
			s.style.top = (py-ph/2-5)+"px";
			s.style.left = (px-pw/2-4)+"px";
		
		}, false);;
	}
	
	
	get value()
	{
		//return this.value;
	}
}
function getRandomId()
{
	var l = 9;
  	return "id"+ Math.floor(Math.random() * Math.floor(l))+
  			Math.floor(Math.random() * Math.floor(l))+
  			Math.floor(Math.random() * Math.floor(l))+
  			Math.floor(Math.random() * Math.floor(l));
}

function vectfromvertices(a, b) {
	if (a[0] == b[0] && a[1] == b[1] && a[2] == b[2])
		return new Vector([0.0, 0.0, 0.0], [0.0, 0.0, 0.0], 0.0);
    var c = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]) + (b[2] - a[2]) * (b[2] - a[2]));
    return new Vector(a, [(b[0] - a[0]) / c, (b[1] - a[1]) / c, (b[2] - a[2]) / c], c)
}
function scalarproduct(a, b) {
    return a[0] * b[0] + a[1] * b[1]
}



