// goserver serves the benchmark app twice: bare and behind the LXS middleware. It prints
// "ready <bareAddr> <lxsAddr>" and runs until killed.
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"

	bench "github.com/SamanPandey-in/lxs/conformance/bench/go"
)

func serve(h http.Handler) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	go func() { log.Fatal(http.Serve(ln, h)) }()
	return ln.Addr().String()
}

func main() {
	m, cleanup, err := bench.Start()
	if err != nil {
		log.Fatal(err)
	}
	defer cleanup()
	fmt.Printf("ready %s %s\n", serve(bench.App), serve(m.Handler(bench.App)))
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt)
	<-c
}
