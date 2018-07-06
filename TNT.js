
//document.getElementsById("stick-1").addEventListener("touchstart", handleStart, false);

function getRandomInt(max)
{
  return Math.floor(Math.random() * Math.floor(max));
}

function Flaminate (flame)
{
	var intervalID;
	intervalID = setInterval(flashText, 100);
  function flashText()
	{
		var state = ["-", "*", "*", "*", "*", "*", "*", "*", "*", "*", "*", ".", "*", "*", "*", "*", "*", "*"];
		var flamecolor = ["yellow", "red", "orange", "white"];

		flame.innerHTML = 
							'<span style="color: '+flamecolor[getRandomInt(flamecolor.length)]+';">'+
								state[getRandomInt(state.length)]+
						   '</span>';
	}
}
/** @constructor */
function Vector(a, b, c) {
    this.o = a;
    this.s = b;
    this.n = c
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
function run()
{
	var flame = document.getElementById("flame");
	var flaminate = new Flaminate(flame);
	

	
	
	var stick = document.getElementById("stick-1");
	stick.addEventListener("touchstart", handleStart, false);;
	stick.addEventListener("touchend", handleEnd, false);;
	stick.addEventListener("mouseenter", handleStart, false);;
	stick.addEventListener("mouseleave", handleEnd, false);;
	stick.addEventListener("touchmove", handleMove, false);;
	
	
	
//	stick.addEventListener("", handleStart, false);;
	var holdStick = false;
	
	var holdstart = {x: 0.0, y: 0.0 };
	
	function handleStart (evt)
	{
		holdStick = true;
		$('#stick-1').css('background-color', '#ccc');
		$('#stick-1').css('border', 'solid 4px #aaa');	
		$('#stick-1	').css('display', 'block');
		console.log(evt);
		holdstart.x = evt.touches[0].clientX;
		holdstart.y = evt.touches[0].clientY;
		
		
	}
	function handleMove (evt)
	{
		holdStick = true;
		$('#stick-1').css('background-color', '#ccc');
		$('#stick-1').css('border', 'solid 2px #aaa');	

		$('#stick-1	').css('display', 'block');
		$('#stick-1-son').css('display', 'block');
		$('#stick-1-son').css('top', (evt.touches[0].clientY-15)+'px');
		$('#stick-1-son').css('left', (evt.touches[0].clientX-15)+'px');
		
		var v = vectfromvertices([holdstart.x, holdstart.y, 0], [evt.touches[0].clientX, evt.touches[0].clientY, 0]);
		console.log(v);

		var intensity = v.n/50*15;
		if ( intensity > 15 ) intensity = 15;
		var top = $( "#stick-1-ground" ).position().top+(v.s[1]*intensity);
		var left = $( "#stick-1-ground" ).position().left+(v.s[0]*intensity);
		
		
		$('#stick-1').css('top', top);
			$('#stick-1').css('left', left);

		
		console.log("\n"+evt.touches[0].clientX.toFixed(1)+" | "+evt.touches[0].clientY.toFixed(1)+"\n"+
		holdstart.x+" | "+holdstart.y);
		
		
	}
	
	
	function handleEnd (evt)
	{
		$('#stick-1').css('background-color', '#aaa');
		$('#stick-1').css('border', 'solid 4px #aaa');	
		var top = $( "#stick-1-ground" ).position().top;
		var left = $( "#stick-1-ground" ).position().left;
		
		
		$('#stick-1').css('top', top);
			$('#stick-1').css('left', left);
		
		
		$('#stick-1	').css('display', 'block');
		$('#stick-1-son').css('display', 'none');
		console.log(evt);
	}
	
	
}
    $(window).on("load",  run());

 /* el.addEventListener("touchend", handleEnd, false);
  el.addEventListener("touchcancel", handleCancel, false);
  el.addEventListener("touchleave", handleLeave, false);
  el.addEventListener("touchmove", handleMove, false);*/






